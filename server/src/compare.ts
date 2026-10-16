import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Deps } from './app';
import { newId } from './db';
import { getChatRow, setActiveLeaf, setCompareParent, touchChat } from './chats';
import { promptFor, replyErrorMessage } from './generate';
import { insertMessage } from './messages';
import { OpenRouterError, type Usage } from './openrouter';
import { resolveApiKey } from './settings';
import { maybeGenerateTitle } from './title';
import type {
  CompareDone, CompareSlot, CompareSlotDone, CompareSlotError, CompareSlotText, CompareStart, Message, MessageStatus, StreamTitle,
} from '../../shared/types';

interface CompareOptions {
  chatId: string;
  /** The user message every model replies to. */
  parentId: string;
  modelIds: string[];
  /** Set when this request created a new user message. */
  userMessageId: string | null;
  /** Called once, when every reply is saved or the stream ends, whichever comes first. */
  onFinish?: () => void;
}

/**
 * Streams replies from several models to the same user message, concurrently, over one SSE response:
 * start → (delta|reasoning|slot-done|slot-error)* → done, then optional title. Each reply is saved as a
 * sibling under `parentId`, and the chat waits for the user to pick one (compare_parent_id).
 */
export function streamComparison(c: Context, deps: Deps, o: CompareOptions): Response {
  const { db, openrouter, env } = deps;
  const { key } = resolveApiKey(db, env);
  const slots: CompareSlot[] = o.modelIds.map((modelId) => ({ assistantMessageId: newId(), modelId }));
  const abort = new AbortController();
  let finished = false;
  c.req.raw.signal.addEventListener('abort', () => abort.abort());

  // Restored if no model replies, so a failed "compare again" doesn't hide the reply that was showing.
  const previousLeaf = getChatRow(db, o.chatId)?.active_leaf_id ?? o.parentId;
  setActiveLeaf(db, o.chatId, o.parentId);
  setCompareParent(db, o.chatId, o.parentId);

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
    // Slots write concurrently; chaining every write keeps SSE frames from interleaving.
    let queue: Promise<unknown> = Promise.resolve();
    const send = (event: string, data: unknown) =>
      (queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));

    await send('start', { userMessageId: o.userMessageId, slots } satisfies CompareStart);
    const saved = (await Promise.all(slots.map((slot, i) => runSlot(i, slot, send)))).filter((m): m is Message => m !== null);

    if (saved.length === 0) {
      setCompareParent(db, o.chatId, null);
      setActiveLeaf(db, o.chatId, previousLeaf);
    }
    touchChat(db, o.chatId);
    if (abort.signal.aborted) return;
    await send('done', { compareParentId: saved.length ? o.parentId : null } satisfies CompareDone);
    finish(); // every reply is saved; titling below shouldn't block the chat

    const firstComplete = saved.find((m) => m.status === 'complete');
    if (firstComplete) {
      const title = await maybeGenerateTitle(deps, o.chatId, key, firstComplete.modelId!);
      if (title) await send('title', { title } satisfies StreamTitle);
    }
  }

  async function runSlot(i: number, slot: CompareSlot, send: (event: string, data: unknown) => Promise<unknown>): Promise<Message | null> {
    let text = '';
    let usage: Usage | null = null;
    const save = (status: MessageStatus): Message =>
      insertMessage(db, {
        id: slot.assistantMessageId,
        chatId: o.chatId,
        parentId: o.parentId,
        role: 'assistant',
        content: text,
        modelId: slot.modelId,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        cost: usage?.cost ?? null,
        status,
      });

    // Each model gets its own prompt: one may see an image another can only read a note about.
    const prompt = promptFor(deps, o.chatId, o.parentId, slot.modelId);
    try {
      if (!key) throw new OpenRouterError('No OpenRouter API key set. Add one in Settings.', 401);
      for await (const event of openrouter.streamChat({ apiKey: key, model: slot.modelId, ...prompt, signal: abort.signal })) {
        if (event.type === 'delta') {
          text += event.text;
          await send('delta', { slot: i, text: event.text } satisfies CompareSlotText);
        } else if (event.type === 'reasoning') {
          await send('reasoning', { slot: i, text: event.text } satisfies CompareSlotText);
        } else if (event.type === 'usage') {
          usage = event.usage;
        }
      }
      const message = save('complete');
      await send('slot-done', { slot: i, message } satisfies CompareSlotDone);
      return message;
    } catch (err) {
      const partial = text ? save('stopped') : null;
      if (!abort.signal.aborted) await send('slot-error', { slot: i, message: replyErrorMessage(err), partial } satisfies CompareSlotError);
      return partial;
    }
  }
}
