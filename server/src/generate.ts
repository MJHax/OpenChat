import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Deps } from './app';
import { newId } from './db';
import { setActiveLeaf, touchChat } from './chats';
import { getChatMessages, insertMessage } from './messages';
import { OpenRouterError, type Usage, type WebSearchMode } from './openrouter';
import { getAttachmentData } from './attachments';
import { modelModalities, modelSupportsTools } from './library';
import { buildMessages, pdfPlugins, type ChatMessage, type Plugin } from './prompt';
import { getPersona, resolveApiKey } from './settings';
import { maybeGenerateTitle } from './title';
import { activePath } from './tree';
import type { Message, MessageStatus, Source, StreamDone, StreamError, StreamStart, StreamTitle } from '../../shared/types';

export function replyErrorMessage(err: unknown): string {
  if (err instanceof OpenRouterError) return err.message;
  console.error(err);
  return 'Something went wrong while generating the reply.';
}

export interface Prompt {
  messages: ChatMessage[];
  plugins?: Plugin[];
  webSearch?: WebSearchMode;
}

/**
 * The prompt for `modelId` replying to `parentId`: images it can't view become notes, PDFs get an engine it can use,
 * and when the user message asked for web search, the model searches with the tool if it can, else the plugin.
 */
export function promptFor(deps: Deps, chatId: string, parentId: string, modelId: string): Prompt {
  const { db } = deps;
  const path = activePath(getChatMessages(db, chatId), parentId);
  const inputModalities = modelModalities(db, modelId);
  const loadData = (id: string) => getAttachmentData(db, id) ?? Buffer.alloc(0);
  const webSearch = path.at(-1)?.webSearch ? (modelSupportsTools(db, modelId) ? 'tool' : 'plugin') : undefined;
  return { messages: buildMessages(getPersona(db), path, { inputModalities, loadData }), plugins: pdfPlugins(path, inputModalities), webSearch };
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
  /** Called once, as soon as the reply is saved or the stream ends, whichever comes first. */
  onFinish?: () => void;
}

/**
 * Streams an assistant reply to `parentId` as SSE: start → delta* → done | error, then optional title.
 * The reply is saved on completion; partial text is saved as 'stopped' on error or client disconnect.
 */
export function streamReply(c: Context, deps: Deps, o: ReplyOptions): Response {
  const { db, openrouter, env } = deps;
  const prompt = promptFor(deps, o.chatId, o.parentId, o.modelId);
  const { key } = resolveApiKey(db, env);
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
      });
      setActiveLeaf(db, o.chatId, message.id);
      touchChat(db, o.chatId);
      return message;
    };

    await send('start', { userMessageId: o.userMessageId, assistantMessageId: assistantId } satisfies StreamStart);
    try {
      if (!key) throw new OpenRouterError('No OpenRouter API key set. Add one in Settings.', 401);
      for await (const event of openrouter.streamChat({ apiKey: key, model: o.modelId, ...prompt, signal: abort.signal })) {
        if (event.type === 'delta') {
          text += event.text;
          await send('delta', { text: event.text });
        } else if (event.type === 'reasoning') {
          await send('reasoning', { text: event.text });
        } else if (event.type === 'sources') {
          sources = mergeSources(sources, event.sources);
        } else if (event.type === 'usage') {
          usage = event.usage;
        }
      }
      const message = save('complete');
      await send('done', { message } satisfies StreamDone);
      finish(); // the reply is saved; titling below shouldn't block new generations in this chat
      const title = await maybeGenerateTitle(deps, o.chatId, key, o.modelId);
      if (title) await send('title', { title } satisfies StreamTitle);
    } catch (err) {
      const partial = text ? save('stopped') : null;
      if (abort.signal.aborted) return; // client went away; nothing to send
      await send('error', { message: replyErrorMessage(err), partial } satisfies StreamError);
    }
  }
}
