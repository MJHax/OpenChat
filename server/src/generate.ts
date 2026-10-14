import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Deps } from './app';
import { newId } from './db';
import { setActiveLeaf, touchChat } from './chats';
import { getChatMessages, insertMessage } from './messages';
import { OpenRouterError, type Usage } from './openrouter';
import { buildMessages } from './prompt';
import { getPersona, resolveApiKey } from './settings';
import { maybeGenerateTitle } from './title';
import { activePath } from './tree';
import type { Message, MessageStatus, StreamDone, StreamError, StreamStart, StreamTitle } from '../../shared/types';

interface ReplyOptions {
  chatId: string;
  /** The user message being replied to. */
  parentId: string;
  modelId: string;
  /** Set when this request created a new user message. */
  userMessageId: string | null;
  /** Called once the stream has fully finished, however it ended. */
  onFinish?: () => void;
}

/**
 * Streams an assistant reply to `parentId` as SSE: start → delta* → done | error, then optional title.
 * The reply is saved on completion; partial text is saved as 'stopped' on error or client disconnect.
 */
export function streamReply(c: Context, deps: Deps, o: ReplyOptions): Response {
  const { db, openrouter, env } = deps;
  const messages = buildMessages(getPersona(db), activePath(getChatMessages(db, o.chatId), o.parentId));
  const { key } = resolveApiKey(db, env);
  const assistantId = newId();
  const abort = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abort.abort());

  return streamSSE(c, async (stream) => {
    try {
      await run(stream);
    } finally {
      o.onFinish?.();
    }
  });

  async function run(stream: SSEStreamingApi) {
    stream.onAbort(() => abort.abort());
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });

    let text = '';
    let usage: Usage | null = null;
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
      });
      setActiveLeaf(db, o.chatId, message.id);
      touchChat(db, o.chatId);
      return message;
    };

    await send('start', { userMessageId: o.userMessageId, assistantMessageId: assistantId } satisfies StreamStart);
    try {
      if (!key) throw new OpenRouterError('No OpenRouter API key set. Add one in Settings.', 401);
      for await (const event of openrouter.streamChat({ apiKey: key, model: o.modelId, messages, signal: abort.signal })) {
        if (event.type === 'delta') {
          text += event.text;
          await send('delta', { text: event.text });
        } else {
          usage = event.usage;
        }
      }
      const message = save('complete');
      await send('done', { message } satisfies StreamDone);
      const title = await maybeGenerateTitle(deps, o.chatId, key, o.modelId);
      if (title) await send('title', { title } satisfies StreamTitle);
    } catch (err) {
      const partial = text ? save('stopped') : null;
      if (abort.signal.aborted) return; // client went away; nothing to send
      const message = err instanceof OpenRouterError ? err.message : 'Something went wrong while generating the reply.';
      if (!(err instanceof OpenRouterError)) console.error(err);
      await send('error', { message, partial } satisfies StreamError);
    }
  }
}
