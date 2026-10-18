import type { DB } from './db';
import type { UsageRow } from './usage';
import { bucketKeys, dayKey, heatmapDays, hourKey, monthKey, rangeWindow } from './statsTime';
import type { ImageSettings } from '../../shared/imageModels';
import type { ImageGeneration, MediaKind, MediaStatsResponse, MediaThreadStats, StatsRange } from '../../shared/types';

/** One paid image or video call, as logged in media_events. */
export interface MediaEventRow {
  createdAt: number;
  kind: MediaKind;
  threadId: string | null;
  messageId: string | null;
  modelId: string;
  mode: ImageGeneration['mode'] | null;
  settings: ImageSettings;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  costEstimated: boolean;
  seconds: number | null;
  durationMs: number | null;
  status: 'complete' | 'error';
}

interface Raw {
  created_at: number; kind: MediaKind; thread_id: string | null; message_id: string | null; model_id: string; mode: MediaEventRow['mode'];
  settings: string; prompt_tokens: number | null; completion_tokens: number | null; cost: number | null; cost_estimated: number;
  seconds: number | null; duration_ms: number | null; status: 'complete' | 'error';
}

const toRow = (r: Raw): MediaEventRow => ({
  createdAt: r.created_at, kind: r.kind, threadId: r.thread_id, messageId: r.message_id, modelId: r.model_id, mode: r.mode,
  settings: JSON.parse(r.settings) as ImageSettings, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, cost: r.cost,
  costEstimated: r.cost_estimated === 1, seconds: r.seconds, durationMs: r.duration_ms, status: r.status,
});

/** Every logged call of one kind (null: all kinds), oldest first; optionally one thread's. */
export function loadMediaEvents(db: DB, kind: MediaKind | null, threadId?: string): MediaEventRow[] {
  const rows = db.prepare(
    `SELECT * FROM media_events WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR thread_id = ?) ORDER BY created_at, id`,
  ).all(kind, kind, threadId ?? null, threadId ?? null) as Raw[];
  return rows.map(toRow);
}

const sum = <T>(rows: T[], pick: (r: T) => number | null) => rows.reduce((t, r) => t + (pick(r) ?? 0), 0);
const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const done = (e: MediaEventRow) => e.status === 'complete';
const hasTokens = (e: MediaEventRow) => e.promptTokens !== null || e.completionTokens !== null;

function avgDuration(events: MediaEventRow[]): number | null {
  const timed = events.filter((e) => done(e) && e.durationMs !== null);
  return ratio(sum(timed, (e) => e.durationMs), timed.length);
}

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}

export interface MediaStatsInput {
  events: MediaEventRow[];
  /** usage_events rows for these threads' titles (thread_kind = kind); others are ignored. */
  titleRows: UsageRow[];
  range: StatsRange;
  now: number;
  tz: string;
  modelNames: Map<string, string>;
  kind: MediaKind;
}

/** The Images or Video view of the Stats page; `allSpend` is filled in by the route. */
export function computeMediaStats({ events, titleRows, range, now, tz, modelNames, kind }: MediaStatsInput): Omit<MediaStatsResponse, 'allSpend'> {
  const window = rangeWindow(range, now, tz);
  const inWindow = (t: number) => (window.start === null || t >= window.start) && t <= now;
  const mine = events.filter((e) => e.kind === kind);
  const inRange = mine.filter((e) => inWindow(e.createdAt));
  const titles = titleRows.filter((r) => r.threadKind === kind && inWindow(r.createdAt));
  const made = inRange.filter(done);
  const tokened = inRange.filter(hasTokens);
  const spend = sum(inRange, (e) => e.cost) + sum(titles, (r) => r.cost);
  const video = kind === 'video';
  const seconds = sum(made, (e) => e.seconds);

  const models = [...groupBy(inRange, (e) => e.modelId)].map(([id, list]) => {
    const ok = list.filter(done);
    const t = list.filter(hasTokens);
    return {
      id, name: modelNames.get(id) ?? id, count: ok.length, spend: sum(list, (e) => e.cost), avgCost: ratio(sum(ok, (e) => e.cost), ok.length),
      avgDurationMs: avgDuration(list), promptTokens: t.length ? sum(t, (e) => e.promptTokens) : null,
      completionTokens: t.length ? sum(t, (e) => e.completionTokens) : null, failures: list.length - ok.length,
      ...(video ? { seconds: sum(ok, (e) => e.seconds) } : {}),
    };
  }).sort((a, b) => b.count - a.count || b.spend - a.spend);

  const bucketOf = range === 'today' ? hourKey : range === 'all' || range === 'year' ? monthKey : dayKey;
  const byBucket = groupBy(inRange, (e) => bucketOf(e.createdAt, tz));
  const first = mine.length ? mine[0].createdAt : null;
  const buckets = bucketKeys(range, now, tz, first).map(({ key, label }) => {
    const list = byBucket.get(key) ?? [];
    return { key, label, count: list.filter(done).length, cost: sum(list, (e) => e.cost) };
  });

  const byDay = groupBy(mine.filter((e) => e.createdAt >= now - 372 * 86_400_000), (e) => dayKey(e.createdAt, tz));
  const heatmap = heatmapDays(now, tz).map((day) => {
    const list = byDay.get(day) ?? [];
    return { day, replies: list.filter(done).length, cost: sum(list, (e) => e.cost) };
  });

  return {
    range,
    tiles: {
      count: made.length,
      spend,
      avgCost: ratio(sum(made, (e) => e.cost), made.length),
      avgDurationMs: avgDuration(inRange),
      promptTokens: sum(tokened, (e) => e.promptTokens),
      completionTokens: sum(tokened, (e) => e.completionTokens),
      tokenModels: new Set(tokened.map((e) => e.modelId)).size,
      failures: inRange.length - made.length,
      ...(video ? { seconds, avgCostPerSecond: ratio(sum(made, (e) => e.cost), seconds) } : {}),
    },
    heatmap,
    buckets,
    models,
    modes: video ? null : {
      new: made.filter((e) => e.mode === 'new').length,
      editGenerated: made.filter((e) => e.mode === 'edit_generated').length,
      editUpload: made.filter((e) => e.mode === 'edit_upload').length,
    },
  };
}

/** One image or video thread's numbers for its header popover, title calls included. */
export function computeMediaThreadStats(events: MediaEventRow[], usageRows: UsageRow[]): MediaThreadStats {
  const made = events.filter(done);
  return {
    count: made.length,
    spend: sum(events, (e) => e.cost) + sum(usageRows, (r) => r.cost),
    avgCost: ratio(sum(made, (e) => e.cost), made.length),
    avgDurationMs: avgDuration(events),
    failures: events.length - made.length,
  };
}

/** Everything spent in the range across chats, images and videos: what OpenRouter will bill. */
export function allSpend(usageRows: UsageRow[], events: MediaEventRow[], range: StatsRange, now: number, tz: string): number {
  const { start } = rangeWindow(range, now, tz);
  const inWindow = (t: number) => (start === null || t >= start) && t <= now;
  return sum(usageRows.filter((r) => inWindow(r.createdAt)), (r) => r.cost) + sum(events.filter((e) => inWindow(e.createdAt)), (e) => e.cost);
}
