import type { DB } from './db';
import { cachedCatalogNames } from './catalog';
import type { UsageRow } from './usage';
import { bucketKeys, dayKey, heatKey, heatmapKeys, hourKey, monthKey, rangeWindow, streaks } from './statsTime';
import type { BigChat, ChatStats, FeatureStats, ModelStats, StatsRange, StatsResponse, UsageBucket } from '../../shared/types';

export interface StatsInput {
  /** Every logged call, lifetime: streaks, tracking-since and All time need all of it. */
  rows: UsageRow[];
  range: StatsRange;
  now: number;
  tz: string;
  /** Existing chats; anything else was deleted. */
  chatTitles: Map<string, string>;
  modelNames: Map<string, string>;
}

/** A reply that produced text. Calls that failed before any text count only toward cost, tokens and error rates. */
const counted = (r: UsageRow) => r.purpose === 'reply' && r.messageId !== null;

const sum = (rows: UsageRow[], pick: (r: UsageRow) => number | null) => rows.reduce((t, r) => t + (pick(r) ?? 0), 0);
const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const tokens = (r: UsageRow) => (r.promptTokens ?? 0) + (r.completionTokens ?? 0);

/** Cached ÷ prompt tokens, over rows that report cache data. */
function cacheHitRate(rows: UsageRow[]): number | null {
  const reporting = rows.filter((r) => r.cachedTokens !== null);
  return ratio(sum(reporting, (r) => r.cachedTokens), sum(reporting, (r) => r.promptTokens));
}

function cacheSavings(rows: UsageRow[]): number | null {
  const known = rows.filter((r) => r.cacheSavings !== null);
  return known.length ? sum(known, (r) => r.cacheSavings) : null;
}

function avgFirstTokenMs(rows: UsageRow[]): number | null {
  const timed = rows.filter((r) => r.purpose === 'reply' && r.firstTokenMs !== null);
  return ratio(sum(timed, (r) => r.firstTokenMs), timed.length);
}

/** Completion tokens per second of streaming, from the first token to the end, over complete replies with timing. */
function outputTokensPerSec(rows: UsageRow[]): number | null {
  const timed = rows.filter((r) => r.purpose === 'reply' && r.status === 'complete' && r.completionTokens !== null
    && r.firstTokenMs !== null && r.durationMs !== null && r.durationMs > r.firstTokenMs);
  return ratio(sum(timed, (r) => r.completionTokens), sum(timed, (r) => (r.durationMs! - r.firstTokenMs!) / 1000));
}

/** Earliest call time, or null; a loop rather than Math.min(...) so a long history can't overflow the stack. */
const earliest = (rows: UsageRow[]): number | null => rows.reduce<number | null>((m, r) => (m === null || r.createdAt < m ? r.createdAt : m), null);

function groupBy<K>(rows: UsageRow[], key: (r: UsageRow) => K): Map<K, UsageRow[]> {
  const out = new Map<K, UsageRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function modelStats(id: string, name: string, rows: UsageRow[]): ModelStats {
  const replyCalls = rows.filter((r) => r.purpose === 'reply');
  const replies = rows.filter(counted).length;
  const tracked = replyCalls.filter((r) => !r.backfilled);
  const reasoning = rows.filter((r) => r.reasoningTokens !== null);
  return {
    id,
    name,
    replies,
    cost: sum(rows, (r) => r.cost),
    tokens: sum(rows, tokens),
    cacheHitRate: cacheHitRate(rows),
    avgFirstTokenMs: avgFirstTokenMs(rows),
    outputTokensPerSec: outputTokensPerSec(rows),
    avgCostPerReply: ratio(sum(replyCalls, (r) => r.cost), replies),
    reasoningTokens: reasoning.length ? sum(reasoning, (r) => r.reasoningTokens) : null,
    errorRate: ratio(tracked.filter((r) => r.status === 'error').length, tracked.length),
    stoppedRate: ratio(tracked.filter((r) => r.status === 'stopped').length, tracked.length),
    webSearches: sum(rows, (r) => r.webSearches),
  };
}

function features(rows: UsageRow[]): FeatureStats {
  const tracked = rows.filter((r) => r.purpose === 'reply' && !r.backfilled);
  const runsOf = (pick: (r: UsageRow) => boolean) => new Set(tracked.filter(pick).map((r) => r.runId)).size;
  // Every slot of a comparison carries the same file count, so take it once per run.
  const filesPerRun = new Map<string | null, number>();
  for (const r of tracked) if (r.kind === 'send' || r.kind === 'edit') filesPerRun.set(r.runId, Math.max(filesPerRun.get(r.runId) ?? 0, r.attachments));
  return {
    compareRuns: runsOf((r) => r.compare),
    webSearchReplies: tracked.filter((r) => counted(r) && r.webSearch).length,
    attachments: [...filesPerRun.values()].reduce((a, b) => a + b, 0),
    regeneratedOrEdited: runsOf((r) => r.kind === 'regenerate' || r.kind === 'edit'),
    inputOutputRatio: ratio(sum(rows, (r) => r.promptTokens), sum(rows, (r) => r.completionTokens)),
  };
}

function biggestChats(rows: UsageRow[], titles: Map<string, string>): { byCost: BigChat[]; byLength: BigChat[] } {
  const chats = [...groupBy(rows.filter((r) => r.chatId !== null && titles.has(r.chatId)), (r) => r.chatId!)].map(([id, list]) => ({
    id, title: titles.get(id)!, cost: sum(list, (r) => r.cost), replies: list.filter(counted).length,
  }));
  return {
    byCost: [...chats].sort((a, b) => b.cost - a.cost).slice(0, 5),
    byLength: [...chats].sort((a, b) => b.replies - a.replies || b.cost - a.cost).slice(0, 5),
  };
}

export function computeStats({ rows, range, now, tz, chatTitles, modelNames }: StatsInput): Omit<StatsResponse, 'allSpend'> {
  const window = rangeWindow(range, now, tz);
  const inRange = rows.filter((r) => (window.start === null || r.createdAt >= window.start) && r.createdAt <= now);
  const replies = inRange.filter(counted);
  const nameOf = (id: string) => modelNames.get(id) ?? id;

  const models = [...groupBy(inRange, (r) => r.modelId)]
    .map(([id, list]) => modelStats(id, nameOf(id), list))
    .sort((a, b) => b.replies - a.replies || b.cost - a.cost);
  const top = models[0]?.replies ? models[0] : null;
  const searched = inRange.filter((r) => (r.webSearches ?? 0) > 0);
  const lifetimeDays = new Set(rows.filter(counted).map((r) => dayKey(r.createdAt, tz)));
  const streak = streaks(lifetimeDays, now, tz);

  const bucketOf = range === 'today' ? hourKey : range === 'all' || range === 'year' ? monthKey : dayKey;
  const byBucket = groupBy(inRange, (r) => bucketOf(r.createdAt, tz));
  const buckets: UsageBucket[] = bucketKeys(range, now, tz, earliest(rows)).map(({ key, label }) => {
    const list = byBucket.get(key) ?? [];
    const reply = list.filter((r) => r.purpose === 'reply');
    const background = list.filter((r) => r.purpose !== 'reply');
    return {
      key, label, replyCost: sum(reply, (r) => r.cost), backgroundCost: sum(background, (r) => r.cost),
      replyTokens: sum(reply, tokens), backgroundTokens: sum(background, tokens), replies: reply.filter(counted).length, backgroundCalls: background.length,
    };
  });

  // The heat map covers the selected range only, so its shading is scaled to that range's busiest cell.
  const cellOf = heatKey(range);
  const byCell = groupBy(inRange, (r) => cellOf(r.createdAt, tz));
  const heatmap = heatmapKeys(range, now, tz, earliest(rows)).map((day) => {
    const list = byCell.get(day) ?? [];
    return { day, replies: list.filter(counted).length, cost: sum(list, (r) => r.cost) };
  });

  const previous = window.previous;
  const biggest = biggestChats(inRange, chatTitles);

  return {
    range,
    tiles: {
      cost: sum(inRange, (r) => r.cost),
      previousCost: previous ? sum(rows.filter((r) => r.createdAt >= previous.start && r.createdAt < previous.end), (r) => r.cost) : null,
      promptTokens: sum(inRange, (r) => r.promptTokens),
      completionTokens: sum(inRange, (r) => r.completionTokens),
      replies: replies.length,
      chats: new Set(replies.map((r) => r.chatId)).size,
      cacheHitRate: cacheHitRate(inRange),
      cacheSavings: cacheSavings(inRange),
      webSearches: sum(inRange, (r) => r.webSearches),
      webSearchCost: sum(searched, (r) => r.cost),
      avgFirstTokenMs: avgFirstTokenMs(inRange),
      outputTokensPerSec: outputTokensPerSec(inRange),
      activeDays: new Set(replies.map((r) => dayKey(r.createdAt, tz))).size,
      rangeDays: window.days,
      currentStreak: streak.current,
      longestStreak: streak.longest,
      topModel: top ? { id: top.id, name: top.name, share: top.replies / replies.length } : null,
    },
    heatmap,
    buckets,
    models,
    features: features(inRange),
    biggestByCost: biggest.byCost,
    biggestByLength: biggest.byLength,
    trackingSince: earliest(rows.filter((r) => !r.backfilled)),
  };
}

/** One chat's numbers across every branch, including its title call. */
export function computeChatStats(rows: UsageRow[]): ChatStats {
  const replies = rows.filter(counted);
  const prompted = replies.filter((r) => r.promptTokens !== null);
  return {
    cost: sum(rows, (r) => r.cost),
    promptTokens: sum(rows, (r) => r.promptTokens),
    completionTokens: sum(rows, (r) => r.completionTokens),
    cacheHitRate: cacheHitRate(rows),
    cacheSavings: cacheSavings(rows),
    replies: replies.length,
    models: new Set(replies.map((r) => r.modelId)).size,
    webSearches: sum(rows, (r) => r.webSearches),
    avgPromptTokens: ratio(sum(prompted, (r) => r.promptTokens), prompted.length),
  };
}

/** Display names: the library's name, else the catalog's; models in neither fall back to their id at use. */
export function modelNames(db: DB): Map<string, string> {
  const names = cachedCatalogNames(db);
  const library = db.prepare('SELECT id, display_name FROM models').all() as { id: string; display_name: string }[];
  for (const m of library) names.set(m.id, m.display_name);
  return names;
}

/** Titles of chats that still exist. */
export function chatTitles(db: DB): Map<string, string> {
  const rows = db.prepare('SELECT id, title FROM chats').all() as { id: string; title: string }[];
  return new Map(rows.map((r) => [r.id, r.title]));
}
