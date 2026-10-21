import type { DB } from './db';
import { cachedPrices } from './catalog';
import type { Usage } from './openrouter';
import type { ThreadKind } from '../../shared/types';
import { parseLocalModelId } from '../../shared/localModels';

export type UsagePurpose = 'reply' | 'title' | 'memory' | 'summary';
export type ReplyKind = 'send' | 'edit' | 'regenerate';
export type UsageStatus = 'complete' | 'stopped' | 'error';

/** One OpenRouter generation call, as the code that made it knows it. */
export interface UsageEventInput {
  purpose: UsagePurpose;
  chatId: string | null;
  /** The saved assistant message; null when the call saved none. */
  messageId: string | null;
  /** Shared by every slot of one comparison; a single reply has its own. */
  runId: string | null;
  kind: ReplyKind | null;
  compare: boolean;
  modelId: string;
  usage: Usage | null;
  webSearch: boolean;
  webSearches: number | null;
  /** Files on the user message a send/edit reply answers; 0 otherwise. */
  attachments: number;
  firstTokenMs: number | null;
  durationMs: number | null;
  status: UsageStatus;
  createdAt: number;
  /** The kind of thread the call was for; 'chat' when left out. */
  threadKind?: ThreadKind;
}

/** A logged call as read back. */
export interface UsageRow {
  id: number;
  createdAt: number;
  purpose: UsagePurpose;
  chatId: string | null;
  messageId: string | null;
  runId: string | null;
  kind: ReplyKind | null;
  compare: boolean;
  modelId: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  cacheSavings: number | null;
  webSearch: boolean;
  webSearches: number | null;
  attachments: number;
  firstTokenMs: number | null;
  durationMs: number | null;
  /** Local models: time spent loading the model into memory; null when it was already loaded or not reported. */
  loadMs: number | null;
  /** Local models: time spent generating; null for OpenRouter calls. */
  generationMs: number | null;
  status: UsageStatus;
  backfilled: boolean;
  threadKind: ThreadKind;
}

/** USD the cached tokens saved, at the cached catalog's current prices; null when a price or the count is unknown. */
export function cacheSavings(db: DB, modelId: string, cachedTokens: number | null): number | null {
  if (cachedTokens === null) return null;
  const prices = cachedPrices(db).get(modelId);
  if (prices?.prompt == null || prices.cacheRead == null) return null;
  return cachedTokens * (prices.prompt - prices.cacheRead);
}

/**
 * How long a local call spent generating: what the server reported, else the stream time after the first token.
 * Null for OpenRouter models, whose generation time isn't known.
 */
export function generationMsFor(modelId: string, usage: Usage | null, firstTokenMs: number | null, durationMs: number | null): number | null {
  if (parseLocalModelId(modelId) === null) return null;
  if (usage?.generationMs != null) return usage.generationMs;
  if (firstTokenMs === null || durationMs === null) return null;
  const span = durationMs - firstTokenMs;
  return span > 0 ? span : null;
}

export function recordUsage(db: DB, e: UsageEventInput): void {
  const u = e.usage;
  db.prepare(
    `INSERT INTO usage_events (created_at, purpose, chat_id, message_id, run_id, kind, compare, model_id, prompt_tokens, completion_tokens,
       cached_tokens, cache_write_tokens, reasoning_tokens, cost, cache_savings, web_search, web_searches, attachments, first_token_ms,
       duration_ms, status, thread_kind, load_ms, generation_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.createdAt, e.purpose, e.chatId, e.messageId, e.runId, e.kind, e.compare ? 1 : 0, e.modelId, u?.promptTokens ?? null,
    u?.completionTokens ?? null, u?.cachedTokens ?? null, u?.cacheWriteTokens ?? null, u?.reasoningTokens ?? null, u?.cost ?? null,
    cacheSavings(db, e.modelId, u?.cachedTokens ?? null), e.webSearch ? 1 : 0, e.webSearches, e.attachments, e.firstTokenMs,
    e.durationMs, e.status, e.threadKind ?? 'chat', u?.loadMs ?? null,
    generationMsFor(e.modelId, u, e.firstTokenMs, e.durationMs),
  );
}

interface Raw {
  id: number; created_at: number; purpose: UsagePurpose; chat_id: string | null; message_id: string | null; run_id: string | null;
  kind: ReplyKind | null; compare: number; model_id: string; prompt_tokens: number | null; completion_tokens: number | null;
  cached_tokens: number | null; cache_write_tokens: number | null; reasoning_tokens: number | null; cost: number | null;
  cache_savings: number | null; web_search: number; web_searches: number | null; attachments: number; first_token_ms: number | null;
  duration_ms: number | null; status: UsageStatus; backfilled: number; thread_kind: ThreadKind; load_ms: number | null;
  generation_ms: number | null;
}

const toRow = (r: Raw): UsageRow => ({
  id: r.id,
  createdAt: r.created_at,
  purpose: r.purpose,
  chatId: r.chat_id,
  messageId: r.message_id,
  runId: r.run_id,
  kind: r.kind,
  compare: r.compare === 1,
  modelId: r.model_id,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  cachedTokens: r.cached_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  reasoningTokens: r.reasoning_tokens,
  cost: r.cost,
  cacheSavings: r.cache_savings,
  webSearch: r.web_search === 1,
  webSearches: r.web_searches,
  attachments: r.attachments,
  firstTokenMs: r.first_token_ms,
  durationMs: r.duration_ms,
  loadMs: r.load_ms,
  generationMs: r.generation_ms,
  status: r.status,
  backfilled: r.backfilled === 1,
  threadKind: r.thread_kind ?? 'chat',
});

/** Calls made at or after `since` (all of them when null), oldest first. */
export function loadUsageRows(db: DB, since: number | null): UsageRow[] {
  const rows = db.prepare('SELECT * FROM usage_events WHERE created_at >= ? ORDER BY created_at, id').all(since ?? 0) as Raw[];
  return rows.map(toRow);
}

/** A chat's calls, oldest first. */
export function loadChatUsageRows(db: DB, chatId: string): UsageRow[] {
  return (db.prepare('SELECT * FROM usage_events WHERE chat_id = ? ORDER BY created_at, id').all(chatId) as Raw[]).map(toRow);
}
