import { useEffect, useRef, useState } from 'react';
import type { Attachment, ChatDetail, LibraryModel, Message, SettingsView } from '../../../shared/types';
import { api, streamComparison, streamGeneration } from '../api';
import { COMPARE_OFF, compareModels, loadCompare, saveCompare, type CompareState } from '../lib/compare';
import { formatCost } from '../lib/format';
import { initialModelId } from '../lib/models';
import { navigate } from '../lib/route';
import { AttachmentChips } from './AttachmentChips';
import { CompareColumns, type Column } from './CompareColumns';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
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
  const [modelId, setModelId] = useState('');
  const [compare, setCompareState] = useState<CompareState>(COMPARE_OFF);
  /** "Compare versions" view: the path index of the reply being compared, and all its versions. */
  const [versions, setVersions] = useState<{ index: number; replies: Message[] } | null>(null);
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

  // Load the chat whenever the route (or an explicit reload request) changes.
  useEffect(() => {
    viewChatRef.current = chatId;
    if (chatId && chatId === createdChatRef.current) {
      createdChatRef.current = null; // we created this chat for an in-flight send; keep its stream
      return;
    }
    setError(null);
    setVersions(null);
    setPending((p) => (p && p.chatId === chatId ? p : null));
    setCompareState(chatId ? loadCompare(chatId) : COMPARE_OFF);
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
      navigate(`#/chat/${id}`);
      onChatsChanged();
      return id;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  async function run(opts: RunOptions) {
    setError(null);
    setVersions(null);
    const streamChat = await ensureChat();
    if (!streamChat) return;
    const isShown = () => viewChatRef.current === streamChat;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending({
      chatId: streamChat,
      baseLength: opts.baseLength,
      userText: opts.kind === 'regenerate' ? null : opts.text,
      userAttachments: opts.kind === 'regenerate' ? [] : opts.attachments,
      startedAt: Date.now(),
      slots: opts.models.map((id) => ({ modelId: id, text: '', reasoning: '', error: null, message: null, done: false })),
    });
    const updateSlot = (slot: number, change: (s: SlotState) => SlotState) => {
      if (!isShown()) return;
      setPending((p) => (p && p.chatId === streamChat ? { ...p, slots: p.slots.map((s, i) => (i === slot ? change(s) : s)) } : p));
    };

    const url = `/api/chats/${streamChat}/${opts.kind === 'send' ? 'messages' : opts.kind}`;
    const modelField = opts.models.length === 1 ? { modelId: opts.models[0] } : { modelIds: opts.models };
    const body =
      opts.kind === 'send' ? { content: opts.text, attachmentIds: opts.attachments.map((a) => a.id), ...modelField }
      : opts.kind === 'regenerate' ? { parentId: opts.parentId, ...modelField }
      : { messageId: opts.messageId, content: opts.text, attachmentIds: opts.attachments.map((a) => a.id), ...modelField };

    let settled = false;
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
          onStart: () => {},
          onDelta: (text) => updateSlot(0, (s) => ({ ...s, text: s.text + text })),
          onReasoning: (text) => updateSlot(0, (s) => ({ ...s, reasoning: s.reasoning + text })),
          onDone: () => { void finish(null); },
          onError: (e) => { void finish(e.message); },
          onTitle: () => onChatsChanged(),
        }, controller.signal);
      } else {
        const failures: string[] = [];
        await streamComparison(url, body, {
          onStart: () => {},
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
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // The server saves partial replies when it notices the disconnect; give it a moment.
        setTimeout(() => { void finish(null); }, 400);
      } else {
        void finish((e as Error).message);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /** The models the next generation uses: the compare list, or the picked model. */
  const runModels = compare.enabled ? compareList : modelId ? [modelId] : null;

  /** Library entries for the models the next generation uses, for the composer's image checks. */
  const replyModels = (runModels ?? []).map((id) => models.find((m) => m.id === id)).filter((m): m is LibraryModel => !!m);

  const send = (text: string, attachments: Attachment[]) =>
    runModels && run({ kind: 'send', text, attachments, baseLength: messages.length, models: runModels });
  const regenerate = (index: number, model: string | null) => {
    const list = model ? [model] : compareList;
    if (list) run({ kind: 'regenerate', parentId: messages[index].parentId!, baseLength: index, models: list });
  };
  const edit = (index: number, text: string, attachments: Attachment[]) =>
    runModels && run({ kind: 'edit', messageId: messages[index].id, text, attachments, baseLength: index, models: runModels });
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
    <div className="chat">
      <header className="chat-header">
        <h1>{chatId ? title : 'New chat'}</h1>
        {detail && detail.chat.totalCost > 0 && <span className="muted small">Total {formatCost(detail.chat.totalCost)}</span>}
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
              onEdit={(text, attachments) => edit(i, text, attachments)}
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
              {!pending.slots[0].text && <ThinkingIndicator startedAt={pending.startedAt} reasoning={pending.slots[0].reasoning} />}
              {pending.slots[0].text && <div className="msg-body"><Markdown text={pending.slots[0].text} /></div>}
              <div className="msg-meta"><span className="model-tag">{nameOf(pending.slots[0].modelId)}</span></div>
            </div>
          )}
          {pending && pending.slots.length > 1 && (
            <CompareColumns
              columns={pending.slots.map((s, i) => ({
                key: String(i), modelName: nameOf(s.modelId), text: s.text, reasoning: s.reasoning,
                startedAt: pending.startedAt, streaming: !s.done, error: s.error, message: s.message,
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
        replyModels={replyModels}
        path={messages}
        onSend={send}
        onStop={() => abortRef.current?.abort()}
      />
    </div>
  );
}
