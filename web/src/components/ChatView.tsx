import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Attachment, ChatDetail, LibraryModel, Message, SettingsView } from '../../../shared/types';
import { api, streamComparison, streamGeneration } from '../api';
import { COMPARE_OFF, compareModels, loadCompare, saveCompare, type CompareState } from '../lib/compare';
import { initialModelId } from '../lib/models';
import { loadSearch, saveSearch } from '../lib/search';
import { navigate } from '../lib/route';
import { AttachmentChips } from './AttachmentChips';
import { ChatStatsPopover } from './ChatStatsPopover';
import { ContextPopover } from './ContextPopover';
import { CompareColumns, type Column } from './CompareColumns';
import { Composer } from './Composer';
import { MessageBody } from './MessageBody';
import { FilePanel } from './FilePanel';
import { FilePanelContext, type FilePanelApi } from './FilePanelContext';
import { saveBlob } from './FileCard';
import { fileKind, fileVersions, parseFileBlocks, type FileBlock } from '../../../shared/files';
import { inlineImages } from '../lib/filePreview';
import { useChatImages } from '../lib/useChatImages';
import { panelView } from '../lib/filePanelState';
import { MessageItem } from './MessageItem';
import { ThinkingIndicator } from './ThinkingIndicator';
import { toDraft } from './useAttachmentDraft';

export interface ChatViewProps {
  chatId: string | null;
  title: string;
  reloadToken: number;
  models: LibraryModel[];
  settings: SettingsView | null;
  onChatsChanged(): void;
}

interface SlotState {
  modelId: string;
  text: string;
  /** Live reasoning from models that think before answering; shown while pending, not saved. */
  reasoning: string;
  error: string | null;
  message: Message | null;
  done: boolean;
}

interface Pending {
  chatId: string;
  /** Number of detail.messages shown above the pending bubbles. */
  baseLength: number;
  /** Optimistic user bubble for send/edit; null for regenerate. */
  userText: string | null;
  userAttachments: Attachment[];
  startedAt: number;
  /** Whether the reply may search the web. */
  webSearch: boolean;
  /** One slot for a normal reply, 2–4 for a comparison. */
  slots: SlotState[];
}

type RunOptions =
  | { kind: 'send'; text: string; attachments: Attachment[]; baseLength: number; models: string[] }
  | { kind: 'regenerate'; parentId: string; baseLength: number; models: string[] }
  | { kind: 'edit'; messageId: string; text: string; attachments: Attachment[]; baseLength: number; models: string[] };

export function ChatView({ chatId, title, reloadToken, models, settings, onChatsChanged }: ChatViewProps) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** An edit the server refused before taking it, to reopen in its edit box. */
  const [failedEdit, setFailedEdit] = useState<{ messageId: string; text: string; attachments: Attachment[] } | null>(null);
  const [modelId, setModelId] = useState('');
  const [compare, setCompareState] = useState<CompareState>(COMPARE_OFF);
  const [webSearch, setWebSearchState] = useState(false);
  /** "Compare versions" view: the path index of the reply being compared, and all its versions. */
  const [versions, setVersions] = useState<{ index: number; replies: Message[] } | null>(null);
  /** The file open in the side panel; `messageId` is the reply it came from (null for a streaming file or a snippet). */
  const [openFile, setOpenFile] = useState<{ name: string; messageId: string | null; adhoc: FileBlock | null } | null>(null);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const [panelWidth, setPanelWidth] = useState(560);
  const abortRef = useRef<AbortController | null>(null);
  const viewChatRef = useRef<string | null>(chatId);
  const createdChatRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const messages = detail?.messages ?? [];
  const streaming = pending !== null;
  const libraryIds = models.map((m) => m.id);
  const compareList = compareModels(compare, libraryIds);
  const choosing = !pending && detail?.compare ? detail.compare : null;

  async function reload(id: string) {
    const next = await api.getChat(id);
    if (viewChatRef.current === id) setDetail(next);
  }

  function setCompare(next: CompareState) {
    setCompareState(next);
    if (chatId) saveCompare(chatId, next);
  }

  function setWebSearch(on: boolean) {
    setWebSearchState(on);
    if (chatId) saveSearch(chatId, on);
  }

  // Load the chat whenever the route (or an explicit reload request) changes.
  useEffect(() => {
    viewChatRef.current = chatId;
    if (chatId && chatId === createdChatRef.current) {
      createdChatRef.current = null; // we created this chat for an in-flight send; keep its stream
      return;
    }
    setError(null);
    setVersions(null);
    setFailedEdit(null);
    setOpenFile(null);
    setPending((p) => (p && p.chatId === chatId ? p : null));
    setCompareState(chatId ? loadCompare(chatId) : COMPARE_OFF);
    setWebSearchState(chatId ? loadSearch(chatId) : false);
    if (!chatId) {
      setDetail(null);
      return;
    }
    reload(chatId).catch((e: Error) => setError(e.message));
  }, [chatId, reloadToken]);

  // New chats start on the default model; existing chats continue with the last model that replied.
  useEffect(() => {
    setModelId(initialModelId(messages, models));
  }, [detail, models]);

  // Keep the newest content in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail, pending?.baseLength]);
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [pending?.slots]);

  async function ensureChat(): Promise<string | null> {
    if (chatId) return chatId;
    try {
      const id = (await api.createChat()).id;
      createdChatRef.current = id;
      viewChatRef.current = id;
      saveCompare(id, compare);
      saveSearch(id, webSearch);
      navigate(`#/chat/${id}`);
      onChatsChanged();
      return id;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  /** Resolves false when the request failed before the server took it, so the caller can give the draft back. */
  async function run(opts: RunOptions): Promise<boolean> {
    setError(null);
    setVersions(null);
    setFailedEdit(null);
    const streamChat = await ensureChat();
    if (!streamChat) return false;
    const isShown = () => viewChatRef.current === streamChat;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending({
      chatId: streamChat,
      baseLength: opts.baseLength,
      userText: opts.kind === 'regenerate' ? null : opts.text,
      userAttachments: opts.kind === 'regenerate' ? [] : opts.attachments,
      startedAt: Date.now(),
      // Regenerate searches again only if the message being answered asked for search.
      webSearch: opts.kind === 'regenerate' ? messages.find((m) => m.id === opts.parentId)?.webSearch ?? false : webSearch,
      slots: opts.models.map((id) => ({ modelId: id, text: '', reasoning: '', error: null, message: null, done: false })),
    });
    const updateSlot = (slot: number, change: (s: SlotState) => SlotState) => {
      if (!isShown()) return;
      setPending((p) => (p && p.chatId === streamChat ? { ...p, slots: p.slots.map((s, i) => (i === slot ? change(s) : s)) } : p));
    };

    const url = `/api/chats/${streamChat}/${opts.kind === 'send' ? 'messages' : opts.kind}`;
    const modelField = opts.models.length === 1 ? { modelId: opts.models[0] } : { modelIds: opts.models };
    const body =
      opts.kind === 'send' ? { content: opts.text, attachmentIds: opts.attachments.map((a) => a.id), webSearch, ...modelField }
      : opts.kind === 'regenerate' ? { parentId: opts.parentId, ...modelField }
      : { messageId: opts.messageId, content: opts.text, attachmentIds: opts.attachments.map((a) => a.id), webSearch, ...modelField };

    let settled = false;
    // The server sends `start` before anything else, after the message is saved; an error before it means nothing was kept.
    let started = false;
    const finish = async (message: string | null) => {
      if (settled) return;
      settled = true;
      if (isShown()) {
        await reload(streamChat).catch(() => {});
        setPending((p) => (p?.chatId === streamChat ? null : p));
        setError(message);
      }
      onChatsChanged();
    };

    try {
      if (opts.models.length === 1) {
        await streamGeneration(url, body, {
          onStart: () => { started = true; },
          onDelta: (text) => updateSlot(0, (s) => ({ ...s, text: s.text + text })),
          onReasoning: (text) => updateSlot(0, (s) => ({ ...s, reasoning: s.reasoning + text })),
          onDone: (e) => {
            void finish(null).then(() => {
              // A finished reply that made files opens its last complete one when no file is open, and moves an open
              // file on to the version this reply just wrote.
              const made = parseFileBlocks(e.message.content).flatMap((s) => (s.type === 'file' && s.file.complete ? [s.file.name] : []));
              const current = openFileRef.current;
              const name = current ? made.find((n) => n === current.name) : made.at(-1);
              if (name && isShown()) setOpenFile({ name, messageId: e.message.id, adhoc: null });
            });
          },
          onError: (e) => { void finish(e.message); },
          onTitle: () => onChatsChanged(),
        }, controller.signal);
      } else {
        const failures: string[] = [];
        await streamComparison(url, body, {
          onStart: () => { started = true; },
          onDelta: (slot, text) => updateSlot(slot, (s) => ({ ...s, text: s.text + text })),
          onReasoning: (slot, text) => updateSlot(slot, (s) => ({ ...s, reasoning: s.reasoning + text })),
          onSlotDone: (e) => updateSlot(e.slot, (s) => ({ ...s, message: e.message, done: true })),
          onSlotError: (e) => {
            failures.push(e.message);
            updateSlot(e.slot, (s) => ({ ...s, error: e.message, message: e.partial, done: true }));
          },
          onDone: (e) => { void finish(e.compareParentId ? null : `None of the models replied. ${failures[0] ?? ''}`.trim()); },
          onError: (e) => { void finish(e.message); },
          onTitle: () => onChatsChanged(),
        }, controller.signal);
      }
      if (!settled) void finish(null); // stream closed without a final event
      return started;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // The server saves partial replies when it notices the disconnect; give it a moment.
        setTimeout(() => { void finish(null); }, 400);
        return true;
      }
      void finish((e as Error).message);
      return started;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /** The models the next generation uses: the compare list, or the picked model. */
  const runModels = compare.enabled ? compareList : modelId ? [modelId] : null;

  /** Library entries for the models the next generation uses, for the composer's image checks. */
  const replyModels = (runModels ?? []).map((id) => models.find((m) => m.id === id)).filter((m): m is LibraryModel => !!m);

  const send = async (text: string, attachments: Attachment[]) =>
    !!runModels && run({ kind: 'send', text, attachments, baseLength: messages.length, models: runModels });
  const regenerate = (index: number, model: string | null) => {
    const list = model ? [model] : compareList;
    if (list) run({ kind: 'regenerate', parentId: messages[index].parentId!, baseLength: index, models: list });
  };
  const edit = async (index: number, text: string, attachments: Attachment[]) => {
    const messageId = messages[index].id;
    if (!runModels) return;
    // The edited message is hidden while the request runs, so its edit box can't hold the draft; reopen it from here.
    if (!(await run({ kind: 'edit', messageId, text, attachments, baseLength: index, models: runModels }))) {
      setFailedEdit({ messageId, text, attachments });
    }
  };
  const retry = () => {
    const last = messages[messages.length - 1];
    if (!last || !runModels) return;
    if (last.role === 'user') run({ kind: 'regenerate', parentId: last.id, baseLength: messages.length, models: runModels });
    else run({ kind: 'regenerate', parentId: last.parentId!, baseLength: messages.length - 1, models: runModels });
  };
  const selectSibling = async (messageId: string) => {
    if (!chatId) return;
    try {
      setDetail(await api.selectMessage(chatId, messageId));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const continueWith = async (messageId: string) => {
    await selectSibling(messageId);
    setVersions(null);
  };
  const openVersions = async (index: number) => {
    if (!chatId) return;
    try {
      setVersions({ index, replies: await api.replies(chatId, messages[index].parentId!) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const chatImages = useChatImages(detail?.chatImages ?? []);
  /** Versions as seen from `messageId`: the active path, plus that reply when it's a comparison column off the path. */
  const versionsFrom = (messageId: string | null) => {
    if (messageId === null || messages.some((m) => m.id === messageId)) return fileVersions(messages);
    const offPath = [...(detail?.compare?.replies ?? []), ...(versions?.replies ?? []), ...(pending?.slots ?? []).flatMap((s) => (s.message ? [s.message] : []))]
      .find((m) => m.id === messageId);
    if (!offPath) return fileVersions(messages);
    const parent = messages.findIndex((m) => m.id === offPath.parentId);
    return fileVersions([...(parent === -1 ? messages : messages.slice(0, parent + 1)), offPath]);
  };
  const filePanel: FilePanelApi = {
    open: (name, messageId, file) => setOpenFile({ name, messageId, adhoc: messageId === null ? file : null }),
    versionOf: (name, messageId) => versionsFrom(messageId).get(name)?.find((v) => v.messageId === messageId)?.version ?? null,
    download: (file) => saveBlob(file, fileKind(file.name) === 'html' ? inlineImages(file.content, chatImages) : file.content),
  };
  const panel = openFile ? panelView(openFile, versionsFrom(openFile.messageId).get(openFile.name) ?? []) : null;
  useEffect(() => {
    if (openFile && !panel) setOpenFile(null);
  }, [openFile, panel === null]);

  const nameOf = (id: string | null) => models.find((m) => m.id === id)?.displayName ?? id ?? '';
  const savedColumns = (replies: Message[]): Column[] =>
    replies.map((m) => ({ key: m.id, modelName: nameOf(m.modelId), text: m.content, reasoning: '', startedAt: 0, streaming: false, error: null, message: m }));

  const shown = pending ? messages.slice(0, pending.baseLength) : versions ? messages.slice(0, versions.index) : messages;
  const noKey = settings !== null && !settings.hasApiKey;
  const noModels = models.length === 0;
  // A user message at the end of the path means its reply was stopped or lost before any text arrived.
  const awaitingReply = !choosing && messages.length > 0 && messages[messages.length - 1].role === 'user';
  const wide = (pending !== null && pending.slots.length > 1) || choosing !== null || versions !== null;
  const disabledReason =
    noModels ? 'Add a model in the Model Library first.'
    : noKey ? 'Add your OpenRouter API key in Settings first.'
    : choosing ? 'Pick a reply to continue.'
    : compare.enabled && !compareList ? 'Choose 2 to 4 models to compare.'
    : null;

  return (
    <FilePanelContext.Provider value={filePanel}>
      <div className={`chat${openFile ? ' with-file' : ''}`} style={{ '--file-panel-width': `${panelWidth}px` } as CSSProperties}>
        <header className="chat-header">
          <h1>{chatId ? title : 'New chat'}</h1>
          <div className="chat-header-tools">
            <ContextPopover chatId={chatId} modelIds={runModels ?? []} nameOf={nameOf} refreshKey={detail} />
            <ChatStatsPopover chatId={chatId} totalCost={detail?.chat.totalCost ?? 0} refreshKey={detail} />
          </div>
        </header>

        <div className="messages" ref={listRef}>
          <div className={`messages-inner${wide ? ' wide' : ''}`}>
            {(noKey || noModels) && (
              <div className="setup-hint">
                {noKey && <div>Add your OpenRouter API key in <a href="#/settings">Settings</a>.</div>}
                {noModels && <div>Add a model in the <a href="#/models">Model Library</a> to start chatting.</div>}
              </div>
            )}
            {!chatId && !pending && !noKey && !noModels && <div className="empty">How can I help you today?</div>}

            {shown.map((m, i) => (
              <MessageItem
                key={m.id}
                message={m}
                modelName={nameOf(m.modelId)}
                models={models}
                disabled={streaming || choosing !== null}
                compareMode={compareList !== null}
                onSelectSibling={selectSibling}
                onRegenerate={(model) => regenerate(i, model)}
                replyModels={replyModels}
                onEdit={(text, attachments) => { void edit(i, text, attachments); }}
                restoredEdit={failedEdit?.messageId === m.id ? failedEdit : null}
                onCompareVersions={() => openVersions(i)}
              />
            ))}

            {pending?.userText != null && (
              <div className="msg user">
                <AttachmentChips items={pending.userAttachments.map(toDraft)} inMessage />
                {pending.userText && <div className="bubble">{pending.userText}</div>}
              </div>
            )}
            {pending && pending.slots.length === 1 && (
              <div className="msg assistant">
                {!pending.slots[0].text && <ThinkingIndicator startedAt={pending.startedAt} reasoning={pending.slots[0].reasoning} webSearch={pending.webSearch} />}
                {pending.slots[0].text && <div className="msg-body"><MessageBody text={pending.slots[0].text} messageId={null} streaming /></div>}
                <div className="msg-meta"><span className="model-tag">{nameOf(pending.slots[0].modelId)}</span></div>
              </div>
            )}
            {pending && pending.slots.length > 1 && (
              <CompareColumns
                columns={pending.slots.map((s, i) => ({
                  key: String(i), modelName: nameOf(s.modelId), text: s.text, reasoning: s.reasoning,
                  startedAt: pending.startedAt, streaming: !s.done, error: s.error, message: s.message, webSearch: pending.webSearch,
                }))}
              />
            )}
            {choosing && <CompareColumns title="Pick the reply to continue with" columns={savedColumns(choosing.replies)} onContinue={continueWith} />}
            {versions && !pending && (
              <CompareColumns title="All versions of this reply" columns={savedColumns(versions.replies)} onContinue={continueWith} onClose={() => setVersions(null)} />
            )}

            {error && !pending && (
              <div className="error-bubble">
                <span>{error}</span>
                {messages.length > 0 && <button onClick={retry} disabled={!runModels}>Retry</button>}
              </div>
            )}
            {!error && !pending && awaitingReply && (
              <div className="no-reply">
                <span className="muted">No reply yet. It was stopped before any text arrived.</span>
                <button onClick={retry} disabled={!!disabledReason}>Generate reply</button>
              </div>
            )}
          </div>
        </div>

        <Composer
          disabledReason={disabledReason}
          streaming={streaming}
          models={models}
          modelId={modelId}
          onModelChange={setModelId}
          compare={compare}
          onCompareChange={setCompare}
          webSearch={webSearch}
          onWebSearchChange={setWebSearch}
          replyModels={replyModels}
          path={messages}
          onSend={send}
          onStop={() => abortRef.current?.abort()}
        />

        {openFile && panel && (
          <>
            <div
              className="file-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file panel"
              onPointerDown={(e) => {
                // Captured, so the drag keeps going (and ends) even when the pointer is over the page's iframe.
                const handle = e.currentTarget;
                handle.setPointerCapture(e.pointerId);
                const startX = e.clientX;
                const startWidth = panelWidth;
                const move = (ev: PointerEvent) => setPanelWidth(Math.max(320, Math.min(window.innerWidth - 480, startWidth + startX - ev.clientX)));
                const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', up);
                handle.addEventListener('pointercancel', up);
              }}
            />
            <FilePanel
              name={openFile.name}
              versions={panel.versions}
              initialVersion={panel.initial}
              adhoc={openFile.adhoc}
              images={chatImages}
              onDownload={filePanel.download}
              onClose={() => setOpenFile(null)}
            />
          </>
        )}
      </div>
    </FilePanelContext.Provider>
  );
}
