import { useEffect, useRef, useState } from 'react';
import type { ChatDetail, LibraryModel, SettingsView } from '../../../shared/types';
import { api, streamGeneration } from '../api';
import { formatCost } from '../lib/format';
import { navigate } from '../lib/route';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { MessageItem } from './MessageItem';

export interface ChatViewProps {
  chatId: string | null;
  title: string;
  reloadToken: number;
  models: LibraryModel[];
  settings: SettingsView | null;
  onChatsChanged(): void;
}

interface Pending {
  chatId: string;
  /** Number of detail.messages shown above the pending bubbles. */
  baseLength: number;
  /** Optimistic user bubble for send/edit; null for regenerate. */
  userText: string | null;
  replyText: string;
  /** Live reasoning from models that think before answering; shown while pending, not saved. */
  reasoningText: string;
  startedAt: number;
  modelId: string;
}

type RunOptions =
  | { kind: 'send'; text: string; baseLength: number; model: string }
  | { kind: 'regenerate'; parentId: string; baseLength: number; model: string }
  | { kind: 'edit'; messageId: string; text: string; baseLength: number; model: string };

export function ChatView({ chatId, title, reloadToken, models, settings, onChatsChanged }: ChatViewProps) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelId, setModelId] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const viewChatRef = useRef<string | null>(chatId);
  const createdChatRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const messages = detail?.messages ?? [];
  const streaming = pending !== null;

  async function reload(id: string) {
    const next = await api.getChat(id);
    if (viewChatRef.current === id) setDetail(next);
  }

  // Load the chat whenever the route (or an explicit reload request) changes.
  useEffect(() => {
    viewChatRef.current = chatId;
    if (chatId && chatId === createdChatRef.current) {
      createdChatRef.current = null; // we created this chat for an in-flight send; keep its stream
      return;
    }
    setError(null);
    setPending((p) => (p && p.chatId === chatId ? p : null));
    if (!chatId) {
      setDetail(null);
      return;
    }
    reload(chatId).catch((e: Error) => setError(e.message));
  }, [chatId, reloadToken]);

  // Default model: last model used in this chat, else the current pick, else the library default.
  useEffect(() => {
    const ids = new Set(models.map((m) => m.id));
    const lastUsed = [...messages].reverse().find((m) => m.role === 'assistant' && m.modelId && ids.has(m.modelId))?.modelId;
    setModelId((current) => lastUsed ?? (ids.has(current) ? current : (models.find((m) => m.isDefault) ?? models[0])?.id ?? ''));
  }, [detail, models]);

  // Keep the newest content in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail, pending?.baseLength]);
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [pending?.replyText]);

  async function run(opts: RunOptions) {
    setError(null);
    let id = chatId;
    if (!id) {
      try {
        id = (await api.createChat()).id;
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      createdChatRef.current = id;
      viewChatRef.current = id;
      navigate(`#/chat/${id}`);
      onChatsChanged();
    }
    const streamChat = id;
    const isShown = () => viewChatRef.current === streamChat;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending({
      chatId: streamChat,
      baseLength: opts.baseLength,
      userText: opts.kind === 'regenerate' ? null : opts.text,
      replyText: '',
      reasoningText: '',
      startedAt: Date.now(),
      modelId: opts.model,
    });

    const url = `/api/chats/${streamChat}/${opts.kind === 'send' ? 'messages' : opts.kind}`;
    const body =
      opts.kind === 'send' ? { content: opts.text, modelId: opts.model }
      : opts.kind === 'regenerate' ? { parentId: opts.parentId, modelId: opts.model }
      : { messageId: opts.messageId, content: opts.text, modelId: opts.model };

    const finish = async (message: string | null) => {
      if (isShown()) {
        await reload(streamChat).catch(() => {});
        setPending(null);
        setError(message);
      }
      onChatsChanged();
    };

    try {
      await streamGeneration(url, body, {
        onStart: () => {},
        onDelta: (text) => {
          if (isShown()) setPending((p) => (p && p.chatId === streamChat ? { ...p, replyText: p.replyText + text } : p));
        },
        onReasoning: (text) => {
          if (isShown()) setPending((p) => (p && p.chatId === streamChat ? { ...p, reasoningText: p.reasoningText + text } : p));
        },
        onDone: () => { void finish(null); },
        onError: (e) => { void finish(e.message); },
        onTitle: () => onChatsChanged(),
      }, controller.signal);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // The server saves the partial reply when it notices the disconnect; give it a moment.
        setTimeout(() => { void finish(null); }, 400);
      } else if (isShown()) {
        setPending(null);
        setError((e as Error).message);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const send = (text: string) => run({ kind: 'send', text, baseLength: messages.length, model: modelId });
  const regenerate = (index: number, model: string) =>
    run({ kind: 'regenerate', parentId: messages[index].parentId!, baseLength: index, model });
  const edit = (index: number, text: string) =>
    run({ kind: 'edit', messageId: messages[index].id, text, baseLength: index, model: modelId });
  const retry = () => {
    const last = messages[messages.length - 1];
    if (!last) return;
    if (last.role === 'user') run({ kind: 'regenerate', parentId: last.id, baseLength: messages.length, model: modelId });
    else run({ kind: 'regenerate', parentId: last.parentId!, baseLength: messages.length - 1, model: modelId });
  };
  const selectSibling = async (messageId: string) => {
    if (!chatId) return;
    try {
      setDetail(await api.selectMessage(chatId, messageId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const nameOf = (id: string | null) => models.find((m) => m.id === id)?.displayName ?? id ?? '';
  const shown = pending ? messages.slice(0, pending.baseLength) : messages;
  const noKey = settings !== null && !settings.hasApiKey;
  const noModels = models.length === 0;
  // A user message at the end of the path means its reply was stopped or lost before any text arrived.
  const awaitingReply = messages.length > 0 && messages[messages.length - 1].role === 'user';

  return (
    <div className="chat">
      <header className="chat-header">
        <h1>{chatId ? title : 'New chat'}</h1>
        {detail && detail.chat.totalCost > 0 && <span className="muted small">Total {formatCost(detail.chat.totalCost)}</span>}
      </header>

      <div className="messages" ref={listRef}>
        <div className="messages-inner">
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
              disabled={streaming}
              onSelectSibling={selectSibling}
              onRegenerate={(model) => regenerate(i, model)}
              onEdit={(text) => edit(i, text)}
            />
          ))}

          {pending?.userText != null && (
            <div className="msg user"><div className="bubble">{pending.userText}</div></div>
          )}
          {pending && (
            <div className="msg assistant">
              {!pending.replyText && <ThinkingIndicator startedAt={pending.startedAt} reasoning={pending.reasoningText} />}
              {pending.replyText && <div className="msg-body"><Markdown text={pending.replyText} /></div>}
              <div className="msg-meta"><span className="model-tag">{nameOf(pending.modelId)}</span></div>
            </div>
          )}

          {error && !pending && (
            <div className="error-bubble">
              <span>{error}</span>
              {messages.length > 0 && <button onClick={retry}>Retry</button>}
            </div>
          )}
          {!error && !pending && awaitingReply && (
            <div className="no-reply">
              <span className="muted">No reply yet. It was stopped before any text arrived.</span>
              <button onClick={retry} disabled={noKey || noModels}>Generate reply</button>
            </div>
          )}
        </div>
      </div>

      <Composer
        disabled={noModels || noKey}
        streaming={streaming}
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        onSend={send}
        onStop={() => abortRef.current?.abort()}
      />
    </div>
  );
}

/** Shown until the first words arrive; reasoning models can think silently for 20+ seconds. */
function ThinkingIndicator({ startedAt, reasoning }: { startedAt: number; reasoning: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="thinking">
      Thinking… {seconds}s
      {reasoning && (
        <details className="reasoning">
          <summary>Show reasoning</summary>
          <div className="reasoning-text">{reasoning}</div>
        </details>
      )}
    </div>
  );
}
