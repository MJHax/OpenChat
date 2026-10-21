import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Deps } from './app';
import { newId, now } from './db';
import { getChatRow, setActiveLeaf, touchChat } from './chats';
import { getChatMessages, insertMessage } from './messages';
import { type Usage, type WebSearchMode } from './openrouter';
import { chatProvider } from './providers';
import { ProviderError } from './providers/types';
import { isLocalModelId } from '../../shared/localModels';
import { chatImageNames, getAttachmentData } from './attachments';
import { modelModalities, modelSupportsReasoning, modelSupportsTools } from './library';
import { buildMessages, pdfPlugins, withCacheMarkers, type ChatMessage, type Plugin } from './prompt';
import { chatPersona } from './settings';
import { maybeGenerateTitle } from './title';
import { activePath } from './tree';
import { generationMsFor, recordUsage, type ReplyKind, type UsageStatus } from './usage';
import type { Effort, Message, MessageStatus, Source, StreamDone, StreamError, StreamStart, StreamTitle } from '../../shared/types';

export function replyErrorMessage(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  console.error(err);
  return 'Something went wrong while generating the reply.';
}

export interface Prompt {
  messages: ChatMessage[];
  plugins?: Plugin[];
  webSearch?: WebSearchMode;
  /** The effort asked for, kept only when the model supports reasoning. */
  effort?: Effort;
}

/**
 * The prompt for `modelId` replying to `parentId`: images it can't view become notes, PDFs get an engine it can use,
 * and when the user message asked for web search, the model searches with the tool if it can, else the plugin.
 */
export function promptFor(deps: Deps, chatId: string, parentId: string, modelId: string, effort?: Effort): Prompt {
  const { db } = deps;
  const path = activePath(getChatMessages(db, chatId), parentId);
  const inputModalities = modelModalities(db, modelId);
  const loadData = (id: string) => getAttachmentData(db, id) ?? Buffer.alloc(0);
  // Local models never search yet (local web search arrives in stage 3), even when the message asked for it.
  const webSearch = path.at(-1)?.webSearch && !isLocalModelId(modelId) ? (modelSupportsTools(db, modelId) ? 'tool' : 'plugin') : undefined;
  const note = getChatRow(db, chatId)?.context_note;
  const messages = buildMessages(chatPersona(db, chatId), path, { inputModalities, loadData }, { imageNames: chatImageNames(db, chatId) }, note);
  return {
    messages: withCacheMarkers(modelId, messages), plugins: pdfPlugins(path, inputModalities), webSearch,
    effort: effort && !isLocalModelId(modelId) && modelSupportsReasoning(db, modelId) ? effort : undefined,
  };
}

/** The `think` to send for `modelId`: only local models that can think take it; undefined leaves the model's default. */
export function thinkFor(db: Deps['db'], modelId: string, thinking: boolean | undefined): boolean | undefined {
  return thinking !== undefined && isLocalModelId(modelId) && modelSupportsReasoning(db, modelId) ? thinking : undefined;
}

/** Adds sources not seen yet (by URL), keeping arrival order and the first title. */
export function mergeSources(existing: Source[], incoming: Source[]): Source[] {
  const seen = new Set(existing.map((s) => s.url));
  return [...existing, ...incoming.filter((s) => !seen.has(s.url) && seen.add(s.url))];
}

/** The tool reports its searches; the plugin always searches once, which shows only as sources. */
export function searchCount(mode: WebSearchMode | undefined, usage: Usage | null, sources: Source[]): number | null {
  return usage?.webSearches ?? (mode === 'plugin' && sources.length > 0 ? 1 : null);
}

interface ReplyOptions {
  chatId: string;
  /** The user message being replied to. */
  parentId: string;
  modelId: string;
  /** Set when this request created a new user message. */
  userMessageId: string | null;
  kind: ReplyKind;
  /** Files on the user message being answered, for send/edit; 0 for regenerate. */
  attachments: number;
  effort?: Effort;
  /** Local thinking models only: false turns thinking off. */
  thinking?: boolean;
  /** Models whose window couldn't hold the chat; their replies are marked as having lost context. */
  droppedModelIds?: Set<string>;
  /** Called once, as soon as the reply is saved or the stream ends, whichever comes first. */
  onFinish?: () => void;
}

/** Times one streamed call: from the request to its first content or reasoning chunk, and to its end. */
export function callTimer() {
  const startedAt = now();
  const t0 = Date.now();
  let firstTokenMs: number | null = null;
  let ended: { firstTokenMs: number | null; durationMs: number } | undefined;
  return {
    startedAt,
    token() {
      firstTokenMs ??= Date.now() - t0;
    },
    /** Ends the timing; later calls return the same numbers, so the saved reply and its usage row agree. */
    finish: () => (ended ??= { firstTokenMs, durationMs: Date.now() - t0 }),
  };
}

/** The timing columns of a saved reply: all null for OpenRouter models, whose replies carry no timing. */
export function timingFields(modelId: string, usage: Usage | null, t: { firstTokenMs: number | null; durationMs: number }) {
  const local = isLocalModelId(modelId);
  return {
    firstTokenMs: local ? t.firstTokenMs : null,
    loadMs: usage?.loadMs ?? null,
    generationMs: generationMsFor(modelId, usage, t.firstTokenMs, t.durationMs),
  };
}

/**
 * Saves a partial reply, or returns null when it can't be saved — e.g. the chat was deleted mid-stream — so the
 * call is still logged: it was paid for either way.
 */
export function saveIfChatExists(save: () => Message): Message | null {
  try {
    return save();
  } catch {
    return null;
  }
}

/** A failed call was stopped if the client went away, otherwise it errored. */
export const failureStatus = (signal: AbortSignal): UsageStatus => (signal.aborted ? 'stopped' : 'error');

/**
 * Streams an assistant reply to `parentId` as SSE: start → delta* → done | error, then optional title.
 * The reply is saved on completion; partial text is saved as 'stopped' on error or client disconnect.
 */
export function streamReply(c: Context, deps: Deps, o: ReplyOptions): Response {
  const { db } = deps;
  const prompt = promptFor(deps, o.chatId, o.parentId, o.modelId, o.effort);
  const assistantId = newId();
  const abort = new AbortController();
  let finished = false;
  c.req.raw.signal.addEventListener('abort', () => abort.abort());

  return streamSSE(c, async (stream) => {
    try {
      await run(stream);
    } finally {
      finish();
    }
  });

  function finish() {
    if (finished) return;
    finished = true;
    o.onFinish?.();
  }

  async function run(stream: SSEStreamingApi) {
    stream.onAbort(() => abort.abort());
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });

    let text = '';
    let usage: Usage | null = null;
    let sources: Source[] = [];
    const timer = callTimer();
    const log = (status: UsageStatus, messageId: string | null) =>
      recordUsage(db, {
        purpose: 'reply', chatId: o.chatId, messageId, runId: newId(), kind: o.kind, compare: false, modelId: o.modelId, usage,
        webSearch: prompt.webSearch !== undefined, webSearches: searchCount(prompt.webSearch, usage, sources), attachments: o.attachments,
        ...timer.finish(), status, createdAt: timer.startedAt,
      });
    const save = (status: MessageStatus): Message => {
      const message = insertMessage(db, {
        id: assistantId,
        chatId: o.chatId,
        parentId: o.parentId,
        role: 'assistant',
        content: text,
        modelId: o.modelId,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        cost: usage?.cost ?? null,
        status,
        sources,
        webSearches: searchCount(prompt.webSearch, usage, sources),
        effort: prompt.effort ?? null,
        contextDropped: o.droppedModelIds?.has(o.modelId) ?? false,
        ...timingFields(o.modelId, usage, timer.finish()),
      });
      setActiveLeaf(db, o.chatId, message.id);
      touchChat(db, o.chatId);
      return message;
    };

    await send('start', { userMessageId: o.userMessageId, assistantMessageId: assistantId } satisfies StreamStart);
    let resolved = false;
    try {
      const provider = chatProvider(deps, o.modelId);
      resolved = true;
      const think = thinkFor(db, o.modelId, o.thinking);
      for await (const event of provider.streamChat({ model: o.modelId, ...prompt, think, signal: abort.signal })) {
        if (event.type === 'delta') {
          timer.token();
          text += event.text;
          await send('delta', { text: event.text });
        } else if (event.type === 'reasoning') {
          timer.token();
          await send('reasoning', { text: event.text });
        } else if (event.type === 'sources') {
          sources = mergeSources(sources, event.sources);
        } else if (event.type === 'usage') {
          usage = event.usage;
        }
      }
      const message = save('complete');
      log('complete', message.id);
      await send('done', { message } satisfies StreamDone);
      finish(); // the reply is saved; titling below shouldn't block new generations in this chat
      const title = await maybeGenerateTitle(deps, o.chatId, o.modelId);
      if (title) await send('title', { title } satisfies StreamTitle);
    } catch (err) {
      const partial = text ? saveIfChatExists(() => save('stopped')) : null;
      if (resolved) log(failureStatus(abort.signal), partial?.id ?? null);
      if (abort.signal.aborted) return; // client went away; nothing to send
      await send('error', { message: replyErrorMessage(err), partial } satisfies StreamError);
    }
  }
}
