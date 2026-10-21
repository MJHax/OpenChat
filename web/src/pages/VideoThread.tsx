import { NEEDS_KEY } from '../lib/needsKey';
import { useEffect, useRef, useState } from 'react';
import { defaultVideoSettings, snapVideoSettings, usd, type VideoModel, type VideoSettings } from '../../../shared/videoModels';
import type { Attachment, ChatDetail, MediaLibraryModel, PathMessage, SettingsView } from '../../../shared/types';
import { api, attachmentUrl, videoUrl } from '../api';
import { navigate } from '../lib/route';
import { loadLibrarySort, pickMediaEntry, sortMediaLibrary } from '../lib/models';
import { renderHint, renderingNote } from '../lib/videoUi';
import { askNotifyPermission } from '../lib/notify';
import { VideoComposer } from '../components/VideoComposer';
import { ErrorText } from '../components/ErrorText';
import { SpendNotice } from '../components/SpendNotice';
import { MediaStatsPopover } from '../components/MediaStatsPopover';
import { SiblingNav } from '../components/SiblingNav';
import { HomeGreeting } from '../components/ChatHome';

interface Props {
  threadId: string | null;
  title: string;
  reloadToken: number;
  settings: SettingsView | null;
  onThreadsChanged(): void;
}

const withStop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function Rendering({ startedAt, aspect, hint, status, lastError }: {
  startedAt: number; aspect: string; hint: string; status: string | null | undefined; lastError: string | null | undefined;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const [w, h] = aspect.split(':').map(Number);
  const elapsed = Date.now() - startedAt;
  return (
    <div className="image-placeholder video-placeholder shimmer" style={{ aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : '16 / 9' }}>
      <div>Rendering… {clock(elapsed)}</div>
      <div className="small">{renderingNote(elapsed, hint, status, lastError)}</div>
    </div>
  );
}

/** A video thread: each try is a prompt with its start→end photos, then the clip. */
export function VideoThread({ threadId, title, reloadToken, settings: appSettings, onThreadsChanged }: Props) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [library, setLibrary] = useState<MediaLibraryModel[]>([]);
  const [modelId, setModelId] = useState('');
  const [settings, setSettings] = useState<VideoSettings | null>(null);
  const [prompt, setPrompt] = useState('');
  const [start, setStart] = useState<Attachment | null>(null);
  const [end, setEnd] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const viewing = useRef(threadId);
  /** The thread this view just created for a send, so moving to it keeps the composer as it is. */
  const createdRef = useRef<string | null>(null);
  /** Same, for the model: a thread this view created keeps the model picked in the composer. */
  const createdModelRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reload = async (id: string) => {
    const next = await api.getChat(id);
    if (viewing.current === id) setDetail(next);
  };

  useEffect(() => { api.listMediaModels('video').then((l) => setLibrary(sortMediaLibrary(l, loadLibrarySort('video')))).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => {
    viewing.current = threadId;
    setError(null);
    // Photos belong to the thread they were sent in; a different thread starts with empty slots.
    if (threadId !== createdRef.current) { setStart(null); setEnd(null); }
    createdRef.current = null;
    if (!threadId) { setDetail(null); return; }
    reload(threadId).catch((e: Error) => setError(e.message));
  }, [threadId, reloadToken]);

  useEffect(() => {
    if (threadId !== createdModelRef.current) setModelId('');
    createdModelRef.current = null;
  }, [threadId]);

  const messages = detail?.messages ?? [];
  const generations = detail?.generations ?? {};
  const rendering = messages.some((m) => m.status === 'generating');

  // The clip renders on the server; check the thread every 10 s until it lands.
  useEffect(() => {
    if (!threadId || !rendering) return;
    const timer = setInterval(() => { reload(threadId).then(onThreadsChanged).catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, [threadId, rendering]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, rendering]);

  // A new thread starts on the default model, an existing one on the model it last used.
  const lastModel = messages.findLast((m) => m.role === 'assistant' && m.modelId)?.modelId ?? null;
  const entry = pickMediaEntry(library, modelId, lastModel);
  const model = (entry?.model ?? null) as VideoModel | null;
  useEffect(() => {
    if (model) setSettings((s) => (s ? snapVideoSettings(model, s) : defaultVideoSettings(model, null)));
  }, [model?.id]);

  async function generate() {
    if (!model || !settings) return;
    setSending(true);
    setError(null);
    try {
      askNotifyPermission();
      let id = threadId;
      if (!id) {
        id = (await api.createChat('video')).id;
        createdRef.current = id;
        createdModelRef.current = id;
        viewing.current = id;
        navigate(`#/video/${id}`);
        onThreadsChanged();
      }
      await api.generateVideo(id, { prompt: prompt.trim(), modelId: model.id, settings, startAttachmentId: start?.id ?? null, endAttachmentId: end?.id ?? null });
      setPrompt('');
      await reload(id);
      onThreadsChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  /** Puts a try's prompt, photos and settings back in the composer to tweak and send again. */
  function retry(m: PathMessage) {
    const g = generations[m.id];
    const user = messages.find((x) => x.id === m.parentId);
    if (!g || !user) return;
    const frames = g.frames ?? { start: null, end: null };
    setPrompt(g.prompt);
    setStart(user.attachments.find((a) => a.id === frames.start) ?? null);
    setEnd(user.attachments.find((a) => a.id === frames.end) ?? null);
    const lib = library.find((e) => e.id === g.modelId);
    if (lib?.model) { setModelId(g.modelId); setSettings(snapVideoSettings(lib.model as VideoModel, g.settings as unknown as VideoSettings)); }
  }

  const selectSibling = async (id: string) => {
    if (threadId) setDetail(await api.selectMessage(threadId, id).catch(() => detail));
  };
  const nameOf = (id: string) => library.find((e) => e.id === id)?.displayName ?? id;
  const blocked = appSettings && !appSettings.hasApiKey ? NEEDS_KEY
    : rendering ? 'A clip is still rendering in this thread.' : sending ? '' : null;

  return (
    <div className={`chat${threadId ? '' : ' home'}`}>
      <header className="chat-header">
        <h1>{threadId ? title : 'New video'}</h1>
        <div className="chat-header-tools">
          {threadId && <MediaStatsPopover threadId={threadId} totalCost={detail?.chat.totalCost ?? 0} refreshKey={detail} noun="clip" />}
        </div>
      </header>
      <div className="messages" ref={listRef}>
        <div className="messages-inner">
          {!threadId && <HomeGreeting prompt="What should we film?" note="Pick a start (and end) photo, and describe what happens." />}
          {messages.map((m) => {
            if (m.role === 'user') {
              return (
                <div key={m.id} className="msg user">
                  {m.attachments.length > 0 && (
                    <div className="upload-thumbs end">
                      {m.attachments.map((a, i) => (
                        <span key={a.id} className="frame-pair">{i > 0 && '→'}<img className="prompt-thumb" src={attachmentUrl(a.id)} alt={a.filename} /></span>
                      ))}
                    </div>
                  )}
                  <div className="bubble">{m.content}</div>
                </div>
              );
            }
            const g = generations[m.id];
            const s = g?.settings as unknown as VideoSettings | undefined;
            const took = g?.finishedAt ? clock(g.finishedAt - g.startedAt) : null;
            const lib = library.find((e) => e.id === g?.modelId);
            return (
              <div key={m.id} className="msg assistant image-reply">
                {m.status === 'generating' && g && s && (
                  <Rendering startedAt={g.startedAt} aspect={s.aspect} hint={renderHint(lib?.recentRenderMs ?? [])} status={g.jobStatus} lastError={g.jobError} />
                )}
                {m.status === 'error' && (
                  <div className="error-bubble">
                    <span>{withStop(g?.error ?? 'The clip could not be made.')} {(m.cost ?? 0) === 0 ? 'Not charged.' : `Charged ${usd(m.cost!)}.`}</span>
                    <button onClick={() => retry(m)}>Retry</button>
                  </div>
                )}
                {m.status === 'complete' && (
                  <video className="video-result" controls preload="metadata" src={videoUrl(m.id)} />
                )}
                {m.status === 'complete' && g && s && (
                  <div className="msg-meta">
                    {m.siblingIds.length > 1 && <SiblingNav ids={m.siblingIds} index={m.siblingIndex} disabled={rendering} onSelect={selectSibling} />}
                    <span className="model-tag">{nameOf(g.modelId)}</span>
                    <span>· {s.duration}s{s.resolution ? ` · ${s.resolution}` : ''} · {s.sound ? 'sound' : 'no sound'}</span>
                    {m.cost !== null && <span>· {usd(m.cost)}</span>}
                    {took && <span>· {took}</span>}
                    <a className="link" href={videoUrl(m.id)} download={`${(title || 'clip').replace(/[^\w -]+/g, '').trim() || 'clip'}.mp4`}>Download</a>
                    <button className="link" onClick={() => retry(m)}>Tweak prompt &amp; retry</button>
                  </div>
                )}
              </div>
            );
          })}
          {error && <div className="error-bubble"><ErrorText message={error} /></div>}
          <SpendNotice refreshKey={detail} />
        </div>
      </div>
      {settings && model ? (
        <VideoComposer
          library={library}
          model={model}
          onModelChange={setModelId}
          settings={settings}
          onSettings={setSettings}
          prompt={prompt}
          onPrompt={setPrompt}
          start={start}
          end={end}
          onStart={setStart}
          onEnd={setEnd}
          onStartAspect={(ratio) => setSettings((s) => (s && model && !threadId ? { ...s, aspect: defaultVideoSettings(model, ratio).aspect } : s))}
          blocked={blocked}
          onGenerate={() => { void generate(); }}
          onError={setError}
        />
      ) : (
        <div className="composer"><div className="composer-box muted">Add a video model in the <a href="#/models">Model Library</a> (Video models) to start.</div></div>
      )}
    </div>
  );
}
