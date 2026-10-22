import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Deps } from './app';
import { newId } from './db';
import { getChatRow, setActiveLeaf, setCompareParent, touchChat } from './chats';
import { callTimer, failureStatus, timingFields, saveIfChatExists, mergeSources, promptFor, replyErrorMessage, searchCount, thinkFor } from './generate';
import { recordUsage, type ReplyKind, type UsageStatus } from './usage';
import { insertMessage } from './messages';
import type { Usage } from './openrouter';
import { chatProvider } from './providers';
import { isLocalModelId, localServerGroups, statusMessage } from '../../shared/localModels';
import { displayNameOf } from './library';
import { maybeGenerateTitle } from './title';
import type {
  Effort,
  CompareDone, CompareSlot, CompareSlotDone, CompareSlotError, CompareSlotStatus, CompareSlotText, CompareStart, Message, MessageStatus, Source, StreamTitle,
} from '../../shared/types';

interface CompareOptions {
  chatId: string;
  /** The user message every model replies to. */
  parentId: string;
  modelIds: string[];
  /** Set when this request created a new user message. */
  userMessageId: string | null;
  kind: ReplyKind;
  /** Files on the user message being answered, for send/edit; 0 for regenerate. */
  attachments: number;
  /** Applied to each model that supports reasoning. */
  effort?: Effort;
  /** Local thinking models only: false turns thinking off. */
  thinking?: boolean;
  /** Models whose window couldn't hold the chat; their replies are marked as having lost context. */
  droppedModelIds?: Set<string>;
  /** Set when a spending limit is reached: OpenRouter slots fail with it, unrun and unlogged; local slots run normally. */
  limitMessage?: string;
  /** Called once, when every reply is saved or the stream ends, whichever comes first. */
  onFinish?: () => void;
}

/**
 * Streams replies from several models to the same user message over one SSE response, concurrently except
 * that different models on one local server reply one at a time, in slot order:
 * start → (delta|reasoning|slot-done|slot-error)* → done, then optional title. Each reply is saved as a
 * sibling under `parentId`, and the chat waits for the user to pick one (compare_parent_id).
 */
export function streamComparison(c: Context, deps: Deps, o: CompareOptions): Response {
  const { db } = deps;
  const slots: CompareSlot[] = o.modelIds.map((modelId) => ({ assistantMessageId: newId(), modelId }));
  const abort = new AbortController();
  const runId = newId();
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
    const orders = turnOrders();
    const results = await Promise.all(orders.map((order) => runInOrder(order, send)));
    // In slot order, whatever order the replies finished in: slot 0 names the chat.
    const bySlot: (Message | null)[] = slots.map(() => null);
    results.forEach((order, k) => order.forEach((m, j) => { bySlot[orders[k][j]] = m; }));
    const saved = bySlot.filter((m): m is Message => m !== null);

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
      const title = await maybeGenerateTitle(deps, o.chatId, firstComplete.modelId!);
      if (title) await send('title', { title } satisfies StreamTitle);
    }
  }

  /** Slot indexes to run one after another: one list per server with several models, and one per other slot. */
  function turnOrders(): number[][] {
    const shared = localServerGroups(o.modelIds).filter((g) => g.length > 1);
    const orders: number[][] = shared.map((g) => slots.flatMap((s, i) => (g.includes(s.modelId) ? [i] : [])));
    const queued = new Set(orders.flat());
    for (let i = 0; i < slots.length; i++) if (!queued.has(i)) orders.push([i]);
    return orders;
  }

  async function runInOrder(order: number[], send: (event: string, data: unknown) => Promise<unknown>): Promise<(Message | null)[]> {
    for (let k = 1; k < order.length; k++) {
      const before = displayNameOf(db, slots[order[k - 1]].modelId);
      await send('status', { slot: order[k], message: `Waiting for ${before} to finish…` } satisfies CompareSlotStatus);
    }
    const results: (Message | null)[] = [];
    for (const i of order) {
      if (abort.signal.aborted) results.push(null);
      else results.push(await runSlot(i, slots[i], send));
    }
    return results;
  }

  async function runSlot(i: number, slot: CompareSlot, send: (event: string, data: unknown) => Promise<unknown>): Promise<Message | null> {
    if (o.limitMessage !== undefined && !isLocalModelId(slot.modelId)) {
      await send('slot-error', { slot: i, message: o.limitMessage, partial: null } satisfies CompareSlotError);
      return null;
    }
    let text = '';
    let usage: Usage | null = null;
    let sources: Source[] = [];
    // Each model gets its own prompt: one may see an image another can only read a note about, and search differently.
    const prompt = promptFor(deps, o.chatId, o.parentId, slot.modelId, o.effort);
    const timer = callTimer();
    const log = (status: UsageStatus, messageId: string | null) =>
      recordUsage(db, {
        purpose: 'reply', chatId: o.chatId, messageId, runId, kind: o.kind, compare: true, modelId: slot.modelId, usage,
        webSearch: prompt.webSearch !== undefined, webSearches: searchCount(prompt.webSearch, usage, sources), attachments: o.attachments,
        ...timer.finish(), status, createdAt: timer.startedAt,
      });
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
        sources,
        webSearches: searchCount(prompt.webSearch, usage, sources),
        effort: prompt.effort ?? null,
        contextDropped: o.droppedModelIds?.has(slot.modelId) ?? false,
        ...timingFields(slot.modelId, usage, timer.finish()),
      });

    let resolved = false;
    try {
      const provider = chatProvider(deps, slot.modelId);
      resolved = true;
      const think = thinkFor(db, slot.modelId, o.thinking);
      for await (const event of provider.streamChat({ model: slot.modelId, ...prompt, think, signal: abort.signal })) {
        if (event.type === 'delta') {
          timer.token();
          text += event.text;
          await send('delta', { slot: i, text: event.text } satisfies CompareSlotText);
        } else if (event.type === 'reasoning') {
          timer.token();
          await send('reasoning', { slot: i, text: event.text } satisfies CompareSlotText);
        } else if (event.type === 'status') {
          await send('status', { slot: i, message: statusMessage(event.status, displayNameOf(db, slot.modelId)) } satisfies CompareSlotStatus);
        } else if (event.type === 'sources') {
          sources = mergeSources(sources, event.sources);
        } else if (event.type === 'usage') {
          usage = event.usage;
        }
      }
      const message = save('complete');
      log('complete', message.id);
      await send('slot-done', { slot: i, message } satisfies CompareSlotDone);
      return message;
    } catch (err) {
      const partial = text ? saveIfChatExists(() => save('stopped')) : null;
      if (resolved) log(failureStatus(abort.signal), partial?.id ?? null);
      if (!abort.signal.aborted) await send('slot-error', { slot: i, message: replyErrorMessage(err), partial } satisfies CompareSlotError);
      return partial;
    }
  }
}
