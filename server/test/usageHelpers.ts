import type { DB } from '../src/db';
import { now } from '../src/db';
import { recordUsage } from '../src/usage';

/** Logs a completed reply the way a real generation would, for fixtures that insert messages directly. */
export function logReply(db: DB, o: { chatId: string; messageId: string; modelId?: string; cost: number }): void {
  recordUsage(db, {
    purpose: 'reply', chatId: o.chatId, messageId: o.messageId, runId: o.messageId, kind: 'send', compare: false, modelId: o.modelId ?? 'm/x',
    usage: { promptTokens: 10, completionTokens: 5, cost: o.cost, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null },
    webSearch: false, webSearches: null, attachments: 0, firstTokenMs: null, durationMs: null, status: 'complete', createdAt: now(),
  });
}
