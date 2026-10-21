import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { defaultSettings, snapSettings, type ImageModel, type ImageSettings } from '../../../shared/imageModels';
import type { Attachment, ChatDetail, ImageGeneration, MediaLibraryModel, PathMessage, SettingsView } from '../../../shared/types';
import { api, attachmentUrl, deleteAttachment, uploadAttachment } from '../api';
import { navigate } from '../lib/route';
import { loadLibrarySort, pickMediaEntry, sortMediaLibrary } from '../lib/models';
import { editTarget } from '../lib/imageTarget';
import { money } from '../lib/imagePrice';
import { shrinkFile } from '../lib/shrinkImage';
import { ImageComposer } from '../components/ImageComposer';
import { ErrorText } from '../components/ErrorText';
import { SpendNotice } from '../components/SpendNotice';
import { MediaStatsPopover } from '../components/MediaStatsPopover';
import { Lightbox } from '../components/Lightbox';
import { SiblingNav } from '../components/SiblingNav';
import { TiltCard } from '../components/TiltCard';
import { HomeGreeting } from '../components/ChatHome';
import { isSvgAttachment } from '../lib/svg';
import { CopySvgButton } from '../components/CopySvgButton';

interface Props {
  threadId: string | null;
  title: string;
  reloadToken: number;
  settings: SettingsView | null;
  onThreadsChanged(): void;
}

/** width / height for a ratio like "16:9"; square for "auto". */
const ratioOf = (aspect: string) => {
  const [w, h] = aspect.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
};

function Generating({ g }: { g: ImageGeneration }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="image-placeholder shimmer" style={{ aspectRatio: String(ratioOf(g.settings.aspect)) } as CSSProperties}>
      Generating… {Math.max(0, Math.round((Date.now() - g.startedAt) / 1000))}s
    </div>
  );
}

/** An image thread: prompts and the pictures they made, editing back and forth. */
export function ImageThread({ threadId, title, reloadToken, settings: appSettings, onThreadsChanged }: Props) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [library, setLibrary] = useState<MediaLibraryModel[]>([]);
  const [modelId, setModelId] = useState('');
  const [settings, setSettings] = useState<ImageSettings | null>(null);
  const [prompt, setPrompt] = useState('');
  const [uploads, setUploads] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  /** An image picked with "Edit this"; null means the latest image. */
  const [target, setTarget] = useState<string | null>(null);
  const [newImage, setNewImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [zoom, setZoom] = useState<{ image: Attachment; message: PathMessage } | null>(null);
  const viewing = useRef(threadId);
  /** The thread this view just created for a send, so moving to it keeps the model picked in the composer. */
  const createdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reload = async (id: string) => {
    const next = await api.getChat(id);
    if (viewing.current === id) setDetail(next);
  };

  useEffect(() => { api.listMediaModels('image').then((l) => setLibrary(sortMediaLibrary(l, loadLibrarySort('image')))).catch((e: Error) => setError(e.message)); }, []);

  useEffect(() => {
    viewing.current = threadId;
    setError(null);
    setTarget(null);
    setNewImage(false);
    if (!threadId) { setDetail(null); return; }
    reload(threadId).catch((e: Error) => setError(e.message));
  }, [threadId, reloadToken]);

  // A thread other than the one this view just created starts from its own model, not the last pick.
  useEffect(() => {
    if (threadId !== createdRef.current) setModelId('');
    createdRef.current = null;
  }, [threadId]);

  const messages = detail?.messages ?? [];
  const generations = detail?.generations ?? {};
  const running = messages.some((m) => m.status === 'generating');

  // An image keeps generating on the server; check back until it lands.
  useEffect(() => {
    if (!threadId || !running) return;
    const timer = setInterval(() => {
      reload(threadId).then(() => onThreadsChanged()).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [threadId, running]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, running]);

  // A new thread starts on the default model, an existing one on the model it last used; a model OpenRouter no longer lists is skipped.
  const lastModel = messages.findLast((m) => m.role === 'assistant' && m.modelId)?.modelId ?? null;
  const model = (pickMediaEntry(library, modelId, lastModel)?.model ?? null) as ImageModel | null;
  // Settings follow the model: a model change snaps them to what it offers.
  useEffect(() => {
    if (model) setSettings((s) => (s ? snapSettings(model, s) : defaultSettings(model)));
  }, [model?.id]);

  const images = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.attachments.map((a) => ({ a, m })));
  const latest = images.at(-1)?.a ?? null;
  const edit = editTarget({ picked: target, newImage, uploads: uploads.length, onPath: images.map((x) => x.a.id) });

  async function onFiles(files: File[]) {
    setUploading(true);
    setError(null);
    try {
      // Big phone photos are shrunk in the browser first, so they fit the attachment limit.
      for (const f of files) {
        const a = await uploadAttachment(await shrinkFile(f), () => {});
        setUploads((u) => [...u, a]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function ensureThread(): Promise<string> {
    if (threadId) return threadId;
    const id = (await api.createChat('image')).id;
    viewing.current = id;
    createdRef.current = id;
    navigate(`#/images/${id}`);
    onThreadsChanged();
    return id;
  }

  async function generate(body: { prompt: string; modelId: string; settings: ImageSettings; targetAttachmentId: string | null; attachmentIds: string[]; parentId?: string }) {
    setSending(true);
    setError(null);
    try {
      const id = await ensureThread();
      await api.generateImage(id, body);
      await reload(id);
      onThreadsChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  }

  async function send() {
    if (!model || !settings) return;
    const ok = await generate({
      prompt: prompt.trim(), modelId: model.id, settings, targetAttachmentId: edit.id, attachmentIds: uploads.map((a) => a.id),
    });
    if (ok) {
      setPrompt('');
      setUploads([]);
      setTarget(null);
      setNewImage(false);
    }
  }

  function again(m: PathMessage) {
    const g = generations[m.id];
    if (!g || !m.parentId) return;
    void generate({ prompt: g.prompt, modelId: g.modelId, settings: g.settings, targetAttachmentId: g.targetAttachmentId, attachmentIds: [], parentId: m.parentId });
  }

  const selectSibling = async (id: string) => {
    if (!threadId) return;
    setDetail(await api.selectMessage(threadId, id).catch(() => detail));
  };

  const nameOf = (id: string) => library.find((e) => e.id === id)?.displayName ?? id;
  const blocked = appSettings && !appSettings.hasApiKey ? 'Needs an OpenRouter key.'
    : running ? 'An image is still being made in this thread.' : sending ? '' : null;

  return (
    <div className={`chat${threadId ? '' : ' home'}`}>
      <header className="chat-header">
        <h1>{threadId ? title : 'New image'}</h1>
        <div className="chat-header-tools">
          {threadId && <MediaStatsPopover threadId={threadId} totalCost={detail?.chat.totalCost ?? 0} refreshKey={detail} />}
        </div>
      </header>
      <div className="messages" ref={listRef}>
        <div className="messages-inner">
          {!threadId && <HomeGreeting prompt="What should we make?" note="Describe an image, or attach a photo to edit." />}
          {messages.map((m) => {
            if (m.role === 'user') {
              return (
                <div key={m.id} className="msg user">
                  {m.attachments.length > 0 && (
                    <div className="upload-thumbs end">{m.attachments.map((a) => <img key={a.id} className="prompt-thumb" src={attachmentUrl(a.id)} alt={a.filename} />)}</div>
                  )}
                  {m.content && <div className="bubble">{m.content}</div>}
                </div>
              );
            }
            const g = generations[m.id];
            const image = m.attachments[0];
            const seconds = g?.finishedAt ? Math.round((g.finishedAt - g.startedAt) / 1000) : null;
            const note = g?.targetAttachmentId
              ? `Edit of image ${images.findIndex((x) => x.a.id === g.targetAttachmentId) + 1 || '?'}` : null;
            return (
              <div key={m.id} className="msg assistant image-reply">
                {m.status === 'generating' && g && (
                  <>
                    {g.targetAttachmentId && <div className="muted small">Editing {g.targetAttachmentId === latest?.id ? 'the image above' : 'an earlier image'}</div>}
                    <Generating g={g} />
                  </>
                )}
                {m.status === 'error' && (
                  <div className="error-bubble">
                    <span>{g?.error ?? 'The image could not be made.'}{(m.cost ?? 0) === 0 ? ' Not charged.' : ''}</span>
                    <button onClick={() => again(m)} disabled={!!blocked}>Retry</button>
                  </div>
                )}
                {image && (
                  <TiltCard as="button" type="button" max={8} className="image-result" onClick={() => setZoom({ image, message: m })} aria-label={`Open ${image.filename}`}>
                    <img src={attachmentUrl(image.id)} alt={g?.prompt ?? image.filename} className={isSvgAttachment(image) ? 'svg-image' : undefined} />
                  </TiltCard>
                )}
                {m.status === 'complete' && g && (
                  <div className="msg-meta">
                    {m.siblingIds.length > 1 && <SiblingNav ids={m.siblingIds} index={m.siblingIndex} disabled={running} onSelect={selectSibling} />}
                    <span className="model-tag">{nameOf(g.modelId)}</span>
                    <span>· {g.settings.aspect}{g.settings.size ? ` · ${g.settings.size}` : ''}{g.settings.quality ? ` · ${g.settings.quality}` : ''}</span>
                    {m.cost !== null && <span>· {money(m.cost)}</span>}
                    {seconds !== null && <span>· {seconds}s</span>}
                    {note && <span className="muted">· {note}</span>}
                    {image && <a className="link" href={attachmentUrl(image.id)} download={image.filename}>Download</a>}
                    {image && isSvgAttachment(image) && <CopySvgButton className="link" src={attachmentUrl(image.id)} />}
                    {image && <button className="link" onClick={() => { setTarget(image.id); setNewImage(false); }}>Edit this</button>}
                    <button className="link" disabled={!!blocked} onClick={() => again(m)}>Again</button>
                  </div>
                )}
              </div>
            );
          })}
          {error && <div className="error-bubble"><ErrorText message={error} /></div>}
          <SpendNotice refreshKey={detail} />
        </div>
      </div>
      {settings && model && (
        <ImageComposer
          library={library}
          model={model}
          onModelChange={setModelId}
          settings={settings}
          onSettings={setSettings}
          prompt={prompt}
          onPrompt={setPrompt}
          uploads={uploads}
          uploading={uploading}
          onFiles={(f) => { void onFiles(f); }}
          onRemoveUpload={(id) => { setUploads((u) => u.filter((a) => a.id !== id)); void deleteAttachment(id).catch(() => {}); }}
          editNote={edit.note}
          hasTarget={edit.id !== null || target !== null || (newImage && latest !== null)}
          newImage={newImage}
          onNewImage={setNewImage}
          refs={(edit.id ? 1 : 0) + uploads.length}
          blocked={blocked}
          onGenerate={() => { void send(); }}
        />
      )}
      {!model && (
        <div className="composer"><div className="composer-box muted">Add an image model in the <a href="#/models">Model Library</a> (Image models) to start.</div></div>
      )}
      {zoom && (
        <Lightbox
          image={zoom.image}
          onEdit={() => { setTarget(zoom.image.id); setNewImage(false); }}
          onAgain={blocked ? undefined : () => again(zoom.message)}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}
