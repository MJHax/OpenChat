# Usage Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every OpenRouter call in a never-deleted usage table and show it on a new Stats page and in a per-chat popover.

**Architecture:** A `usage_events` table is written by the reply, compare, title and memory paths, and backfilled once from existing messages. Pure TypeScript functions turn rows into a `StatsResponse` (grouping by local day in the viewer's IANA zone); two routes serve it. The web app adds a `#/stats` page built from plain HTML/CSS (no chart library) and a popover in the chat header.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-usage-stats-design.md` — read it alongside this plan; definitions of every number live there.

## Global Constraints

- `usage_events` rows are never deleted; `chat_id` has **no foreign key**.
- Missing usage fields are stored as `null`, never `0`.
- "Counted reply" = `purpose = 'reply'` **and** `message_id IS NOT NULL`. Failed-with-no-text calls count only in cost, tokens and the Errors / stopped share.
- Rates and averages are computed only over rows that have the field; no rows → `null` (UI shows "—"). Never `NaN` or `Infinity`.
- Errors / stopped share: base is non-backfilled reply calls of that model in range.
- Ranges are rolling in the viewer's zone: Year 365 d, Month 30 d, Week 7 d, Today since local midnight; All time has no start and no previous period. Today's previous period = yesterday midnight → same time yesterday.
- Heatmap always covers the last 12 months regardless of range.
- Streaks are lifetime.
- Chat totals (sidebar and header) = `SUM(usage_events.cost)` for the chat.
- No new dependencies. Web tests cover `web/src/lib/*` only (the repo has no component tests).
- Copy: footnote "Cache, speed, error and feature stats are tracked from <date>."; empty "No usage in this range".
- Commit messages follow the repo style (`feat(server): …`, `feat(web): …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Bad query params** — `GET /api/stats` with an unknown `range` or an invalid `tz` must return 400 with a message, not throw. Test added to Task 6.
2. **DST day boundaries** — a reply at 23:30 local on the day clocks change must land on that local day, and Today's start must be local midnight. Test added to Task 4 (America/New_York, 2026-11-01).
3. **Zero denominators** — a model with only title calls, or rows with `prompt_tokens = 0`, must yield `null` rates, not `NaN`. Test added to Task 5.
4. **Aborted and empty failures** — a comparison where one slot fails before any text and the client then disconnects must still log a row for every slot (`'error'` / `'stopped'`). Test added to Task 3.
5. **Unsaved new chat** — the popover on `#/` (no chat id yet) shows zeros without calling the API. Covered by `emptyChatStats()` in Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/openrouter.ts` (modify) | Parse cache/reasoning usage; `complete()` reports usage; catalog `cacheReadPrice` |
| `server/src/catalog.ts` (modify) | `cachedPrices()` |
| `server/src/db.ts` (modify) | `usage_events` schema + one-time backfill |
| `server/src/usage.ts` (create) | `recordUsage`, `cacheSavings`, row types |
| `server/src/generate.ts`, `compare.ts`, `title.ts`, `memorySuggest.ts`, `routes/generate.ts` (modify) | Write rows |
| `server/src/statsTime.ts` (create) | Pure zone/range/bucket helpers |
| `server/src/stats.ts` (create) | Pure `computeStats`, `computeChatStats`; DB loaders |
| `server/src/routes/stats.ts` (create) | `GET /api/stats` |
| `server/src/chats.ts`, `routes/chats.ts` (modify) | Totals from log; `GET /api/chats/:id/stats` |
| `shared/types.ts` (modify) | `StatsRange`, `StatsResponse`, `ChatStats`, … |
| `web/src/lib/stats.ts` (create) | Formatting, heatmap layout, shade levels, range storage |
| `web/src/pages/Stats.tsx` + `web/src/components/stats/*.tsx` (create) | Page and its sections |
| `web/src/components/ChatStatsPopover.tsx` (create) | Header popover |

---

### Task 1: OpenRouter usage fields, `complete()` usage, cache-read price

**Files:**
- Modify: `server/src/openrouter.ts`, `server/src/catalog.ts`, `shared/types.ts` (`CatalogModel`, `withCatalogDefaults`)
- Test: `server/test/openrouter.test.ts`

**Interfaces:**
- Produces:
  - `Usage` gains `cachedTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null`.
  - `complete(o: { apiKey; model; messages; maxTokens?; onUsage?: (u: Usage) => void }): Promise<string>` — return type unchanged so existing mocks keep working; calls `onUsage` when the response has `usage`. Request body adds `usage: { include: true }`.
  - `CatalogModel.cacheReadPrice: number | null` (USD per token, from `pricing.input_cache_read`); `withCatalogDefaults` defaults it to `null`.
  - `cachedPrices(db: DB): Map<string, { prompt: number | null; cacheRead: number | null }>` in `catalog.ts` — empty for a legacy cache; a cached model without `cacheReadPrice` (cache written before this change) maps it to `null`.

- [ ] **Step 1: Probe (ask the user first).** Ask the user for permission to spend a few cents on a probe with their key. If they agree, send one streamed and one non-streamed request with a ~2k-token repeated system prompt, twice each, to one Anthropic, one OpenAI and one DeepSeek or Gemini model, and record in this plan, under this step, where `cached_tokens`, `cache_write_tokens` and `reasoning_tokens` appear in `usage`. If the names differ from `prompt_tokens_details.cached_tokens`, `prompt_tokens_details.cache_write_tokens` and `completion_tokens_details.reasoning_tokens`, use the observed names below. If they decline, use those names.
- [ ] **Step 2: Write failing tests** in `openrouter.test.ts`:
  - `streamChat` usage chunk `{ prompt_tokens: 100, completion_tokens: 20, cost: 0.01, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 8 } }` → `usage` event with `cachedTokens: 60, cacheWriteTokens: 0, reasoningTokens: 8`.
  - A usage chunk without the detail objects → all three `null`.
  - `complete` with a response carrying `usage` calls `onUsage` with the parsed `Usage`; the request body includes `usage: { include: true }`; still returns the text.
  - `listModels` maps `pricing.input_cache_read: '0.0000003'` → `cacheReadPrice: 3e-7`; missing → `null`.
- [ ] **Step 3: Run** `npx vitest run server/test/openrouter.test.ts` — expect the new tests to FAIL.
- [ ] **Step 4: Implement.** Note: `toCount` drops 0, so it's wrong for these fields: use a helper that keeps 0 and turns anything that isn't a number into `null`. Share one `parseUsage(raw): Usage` between the stream and `complete`. Add `cachedPrices`.
- [ ] **Step 5: Run** `npx vitest run` and `npm run typecheck` — all PASS. Fix any test fixtures that build a `Usage` literal (e.g. `USAGE` in `generate.test.ts`) by adding the three fields as `null`.
- [ ] **Step 6: Commit** `feat(server): cache, reasoning and completion usage from OpenRouter`.

---

### Task 2: `usage_events` table, `recordUsage`, backfill

**Files:**
- Create: `server/src/usage.ts`
- Modify: `server/src/db.ts`
- Test: `server/test/usage.test.ts` (create)

**Interfaces:**
- Consumes: `cachedPrices` (Task 1).
- Produces (in `usage.ts`):
  ```ts
  export type UsagePurpose = 'reply' | 'title' | 'memory';
  export type ReplyKind = 'send' | 'edit' | 'regenerate';
  export type UsageStatus = 'complete' | 'stopped' | 'error';
  export interface UsageEventInput {
    purpose: UsagePurpose; chatId: string | null; messageId: string | null; runId: string | null;
    kind: ReplyKind | null; compare: boolean; modelId: string; usage: Usage | null;
    webSearch: boolean; webSearches: number | null; attachments: number;
    firstTokenMs: number | null; durationMs: number | null; status: UsageStatus; createdAt: number;
  }
  export interface UsageRow { /* one field per column, camelCase, as read back */ }
  export function recordUsage(db: DB, e: UsageEventInput): void;   // computes cache_savings itself
  export function cacheSavings(db: DB, modelId: string, cachedTokens: number | null): number | null;
  export function loadUsageRows(db: DB, since: number | null): UsageRow[];  // created_at >= since, ordered by created_at
  ```
- Schema columns exactly as the spec's table (snake_case), `id INTEGER PRIMARY KEY AUTOINCREMENT`, booleans as `INTEGER 0/1`, indexes on `created_at`, `chat_id`, `model_id`.

- [ ] **Step 1: Write failing tests** in `usage.test.ts`:
  - `recordUsage` then `loadUsageRows(db, null)` round-trips every field; `null` usage → `promptTokens`, `cost` etc. `null`.
  - `cacheSavings`: catalog cache with `{ id: 'a/b', promptPrice: 3e-6, cacheReadPrice: 3e-7 }` and `cachedTokens: 1000` → `≈ 0.0027`; unknown model, missing `cacheReadPrice`, or `cachedTokens: null` → `null`.
  - Deleting a chat (`deleteChat`) leaves its usage rows.
  - Backfill: a DB file with a chat, a user message `webSearch: true` and two assistant messages (one `'stopped'`, costs 0.25 and 0.5), with no `usage_events` table and no flag, then `openDb` again → two rows with `backfilled: true`, `purpose: 'reply'`, `webSearch: true`, matching costs, `status`, `createdAt`, distinct `runId`s, `kind: null`, `compare: false`. Opening a third time adds nothing.
- [ ] **Step 2: Run** `npx vitest run server/test/usage.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the schema in `SCHEMA`, and the backfill inside `migrate()`, guarded by settings key `usage_backfill_done = '1'` (set in the same transaction). For a fresh DB the backfill copies nothing and sets the flag. To build the backfill test fixture, use a temp file DB, and drop the table and flag after the first `openDb`.
- [ ] **Step 4: Run** `npx vitest run` — all PASS.
- [ ] **Step 5: Commit** `feat(server): usage log table with one-time backfill`.

---

### Task 3: Log replies, comparisons, titles and memory suggestions

**Files:**
- Modify: `server/src/generate.ts`, `server/src/compare.ts`, `server/src/title.ts`, `server/src/memorySuggest.ts`, `server/src/routes/generate.ts`
- Test: `server/test/generate.test.ts`, `server/test/compare.test.ts`, `server/test/memorySuggest.test.ts`

**Interfaces:**
- Consumes: `recordUsage`, `loadUsageRows`, `ReplyKind` (Task 2); `complete({ onUsage })` (Task 1).
- Produces: `ReplyOptions` and `CompareOptions` gain `kind: ReplyKind; attachments: number`. The route passes `kind: 'send' | 'edit' | 'regenerate'` and `attachments: attachments.length` (0 for regenerate). `streamComparison` makes one `runId = newId()` for all slots; `streamReply` makes its own.

Timing: `start = Date.now()` just before `streamChat`; `firstTokenMs` on the first `delta` or `reasoning` event; `durationMs` when the call ends. Status: `'complete'` on success; on failure `abort.signal.aborted ? 'stopped' : 'error'`. Write the row after the message is saved (so `messageId` is set) or, when no text arrived, with `messageId: null`. `webSearch` is `prompt.webSearch !== undefined`.

- [ ] **Step 1: Write failing tests:**
  - `generate.test.ts`: a send logs one `'reply'` row with `kind: 'send'`, `messageId` = the saved reply, tokens/cost from `USAGE`, `status: 'complete'`, non-null `durationMs` and `firstTokenMs`, plus one `'title'` row for the chat when `complete` calls `onUsage`. A regenerate logs `kind: 'regenerate'`; an edit logs `kind: 'edit'`; a send with 2 attachments logs `attachments: 2`.
  - Failure before any text (`failWith` an `OpenRouterError`, `chunks: []`) → row with `status: 'error'`, `messageId: null`. Failure after text → `status: 'error'` with `messageId` set.
  - No API key → no row.
  - A title call where `complete` throws → `'title'` row with `status: 'error'`.
  - `compare.test.ts`: three models where model 2 fails before any text → 3 rows, same `runId`, all `compare: true`, model 2 `status: 'error'`, `messageId: null`. **(Review Focus 4)** Abort the request mid-stream (pass an `AbortSignal` to `app.request` and abort after the first delta) → every slot still has a row, and aborted slots are `'stopped'`.
  - `memorySuggest.test.ts`: a suggestion logs a `'memory'` row with `chatId: null`.
- [ ] **Step 2: Run** `npx vitest run server/test/generate.test.ts server/test/compare.test.ts server/test/memorySuggest.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** In `title.ts` and `memorySuggest.ts`, time the `complete` call, capture usage via `onUsage`, and record in both the success and the catch path (`chatId` = the chat for titles, `null` for memory).
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` — all PASS.
- [ ] **Step 5: Commit** `feat(server): log every reply, title and memory call`.

---

### Task 4: Time helpers

**Files:**
- Create: `server/src/statsTime.ts`
- Modify: `shared/types.ts` (add `export type StatsRange = 'all' | 'year' | 'month' | 'week' | 'today';`)
- Test: `server/test/statsTime.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isValidZone(tz: string): boolean;
  export function dayKey(ts: number, tz: string): string;      // 'YYYY-MM-DD'
  export function monthKey(ts: number, tz: string): string;    // 'YYYY-MM'
  export function hourKey(ts: number, tz: string): string;     // 'YYYY-MM-DDTHH'
  export function startOfLocalDay(ts: number, tz: string): number;
  export function rangeWindow(range: StatsRange, now: number, tz: string):
    { start: number | null; previous: { start: number; end: number } | null; days: number | null };
  export function bucketKeys(range: StatsRange, now: number, tz: string, firstEventAt: number | null): { key: string; label: string }[];
  export function heatmapDays(now: number, tz: string): string[];  // oldest→today, starting on the Sunday on or before today−364 days
  export function streaks(activeDays: Set<string>, now: number, tz: string): { current: number; longest: number };
  ```
- `days`: 365/30/7/1, `null` for all. `bucketKeys`: all → every month from the first event's month to now (`[]` if no events); year → months from the start's month to now; month/week → each local day; today → hours 00–23 of today. Labels: `'Oct'` / `'Oct 16'` / `'14:00'` (use `Intl` in the zone).
- Use `Intl.DateTimeFormat(..., { timeZone: tz }).formatToParts`. `startOfLocalDay` finds the zone offset at `ts` and subtracts the local time-of-day, then corrects once if the result's `dayKey` differs (DST).

- [ ] **Step 1: Write failing tests:**
  - `dayKey(Date.UTC(2026, 9, 16, 3, 0), 'America/New_York') === '2026-10-15'`.
  - **(Review Focus 2)** `startOfLocalDay` for 2026-11-01 15:00 New York returns the instant of 2026-11-01 00:00 EDT (`Date.UTC(2026,10,1,4,0)`); for 2026-11-02 12:00 returns `Date.UTC(2026,10,2,5,0)`. `dayKey` of 23:30 local on 2026-11-01 is `'2026-11-01'`.
  - `rangeWindow('today', now, tz)`: `start = startOfLocalDay(now)`; `previous.start = startOfLocalDay(start − 1)` (yesterday 00:00); `previous.end = previous.start + (now − start)`; `'month'` → `start = now − 30d`, `previous = { start: now − 60d, end: now − 30d }`; `'all'` → `{ start: null, previous: null, days: null }`.
  - `bucketKeys('week', …)` has 7 day keys ending today; `'today'` has 24; `'all'` with `firstEventAt: null` is `[]`.
  - `heatmapDays` length is between 365 and 371, and its first day is a Sunday.
  - `streaks`: days {today, yesterday, 3 days ago} → `{ current: 2, longest: 2 }`; nothing today but yesterday and the day before → `current: 2`; empty set → `{ 0, 0 }`.
  - `isValidZone('Mars/Base') === false`.
- [ ] **Step 2: Run** `npx vitest run server/test/statsTime.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(server): time-zone range and bucket helpers for stats`.

---

### Task 5: `computeStats` and `computeChatStats`

**Files:**
- Create: `server/src/stats.ts`
- Modify: `shared/types.ts`
- Test: `server/test/stats.test.ts`

**Interfaces:**
- Consumes: `UsageRow` (Task 2), the Task 4 helpers.
- Produces, in `shared/types.ts`:
  ```ts
  export interface StatsTiles {
    cost: number; previousCost: number | null; promptTokens: number; completionTokens: number;
    replies: number; chats: number; cacheHitRate: number | null; cacheSavings: number | null;
    webSearches: number; webSearchCost: number; avgFirstTokenMs: number | null; outputTokensPerSec: number | null;
    activeDays: number; rangeDays: number | null; currentStreak: number; longestStreak: number;
    topModel: { id: string; name: string; share: number } | null;
  }
  export interface HeatDay { day: string; replies: number; cost: number }
  export interface UsageBucket { key: string; label: string; replyCost: number; backgroundCost: number;
    replyTokens: number; backgroundTokens: number; replies: number; backgroundCalls: number }
  export interface ModelStats { id: string; name: string; replies: number; cost: number; tokens: number;
    cacheHitRate: number | null; avgFirstTokenMs: number | null; outputTokensPerSec: number | null;
    avgCostPerReply: number | null; reasoningTokens: number | null; errorRate: number | null;
    stoppedRate: number | null; webSearches: number }
  export interface FeatureStats { compareRuns: number; webSearchReplies: number; attachments: number;
    regeneratedOrEdited: number; inputOutputRatio: number | null }
  export interface BigChat { id: string; title: string; cost: number; replies: number }
  export interface StatsResponse { range: StatsRange; tiles: StatsTiles; heatmap: HeatDay[]; buckets: UsageBucket[];
    models: ModelStats[]; features: FeatureStats; biggestByCost: BigChat[]; biggestByLength: BigChat[];
    trackingSince: number | null }
  export interface ChatStats { cost: number; promptTokens: number; completionTokens: number;
    cacheHitRate: number | null; cacheSavings: number | null; replies: number; models: number;
    webSearches: number; avgPromptTokens: number | null }
  ```
- In `stats.ts`:
  ```ts
  export interface StatsInput { rows: UsageRow[]; range: StatsRange; now: number; tz: string;
    chatTitles: Map<string, string>; modelNames: Map<string, string> }
  export function computeStats(i: StatsInput): StatsResponse;   // pure
  export function computeChatStats(rows: UsageRow[]): ChatStats; // pure
  ```
- `rows` passed to `computeStats` cover lifetime (needed for streaks, `trackingSince` and the All time buckets); the function filters per section. `trackingSince` = `createdAt` of the earliest non-backfilled row. Models sort by `replies` desc, then `cost` desc. Biggest chats: only ids in `chatTitles`, top 5. `topModel.share` = its replies ÷ total counted replies. Features use non-backfilled rows only; `compareRuns` = distinct `runId` where `compare`; `attachments` summed once per `runId` of kind send/edit; `regeneratedOrEdited` = distinct `runId` with kind regenerate or edit. Name fallback: `modelNames.get(id) ?? id`.

- [ ] **Step 1: Write failing tests** with a small `row()` factory (defaults: counted complete reply, `backfilled: false`):
  - Tiles for `'week'`: cost includes a `'title'` row; `replies` excludes a `messageId: null` error row; `chats` counts a chat id that isn't in `chatTitles` (deleted); `previousCost` sums rows 7–14 days ago.
  - `cacheHitRate` over rows with `cachedTokens` only: rows (prompt 100, cached 50), (prompt 100, cached null) → `0.5`.
  - **(Review Focus 3)** A model with only a `'title'` row → `replies: 0`, `avgCostPerReply: null`, `errorRate: null`, appearing after models with replies; rows with `promptTokens: 0, cachedTokens: 0` → `cacheHitRate: null`. Assert nothing in the response is `NaN` (walk the object).
  - `errorRate`/`stoppedRate` ignore backfilled rows; 1 error + 1 stopped + 2 complete → `0.25` / `0.25`.
  - `outputTokensPerSec`: completion 100, first 500 ms, duration 2500 ms → `50`.
  - Heatmap: always 365–371 days even for `'today'`; a counted reply yesterday shows `replies: 1` on that day.
  - Buckets for `'today'` split reply vs background cost.
  - `biggestByCost` skips deleted chats and caps at 5; `biggestByLength` orders by counted replies.
  - Features: a 3-slot comparison (one `runId`) with `attachments: 2` on each row → `compareRuns: 1`, `attachments: 2`.
  - `trackingSince` ignores backfilled rows; all backfilled → `null`.
  - `computeChatStats([])` → all zeros and `null` rates; with rows from 2 models → `models: 2`, `avgPromptTokens` over counted replies.
- [ ] **Step 2: Run** `npx vitest run server/test/stats.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(server): stats aggregation`.

---

### Task 6: Stats routes and chat totals from the log

**Files:**
- Create: `server/src/routes/stats.ts`
- Modify: `server/src/app.ts`, `server/src/chats.ts`, `server/src/routes/chats.ts`, `server/src/stats.ts` (add DB loaders)
- Test: `server/test/statsRoutes.test.ts` (create), `server/test/chats.test.ts`, `server/test/db.test.ts`

**Interfaces:**
- Consumes: `computeStats`, `computeChatStats`, `loadUsageRows`, `isValidZone`.
- Produces:
  - `GET /api/stats?range=<StatsRange>&tz=<IANA>` → `StatsResponse`. 400 `"Unknown range."` / `"Unknown time zone."`.
  - `GET /api/chats/:id/stats` → `ChatStats`; 404 for an unknown chat.
  - `modelNames(db): Map<string, string>` in `stats.ts` — library display name, else catalog name.
  - `listChats` and `getChatDetail` compute `totalCost` from `usage_events`.

- [ ] **Step 1: Write failing tests:**
  - `statsRoutes.test.ts`: after one send through the app, `GET /api/stats?range=all&tz=UTC` returns `tiles.replies: 1`, a model row with the library display name, and `biggestByCost[0].id` = the chat. **(Review Focus 1)** `range=decade` → 400; `tz=Mars/Base` → 400; missing `tz` → 400.
  - `GET /api/chats/:id/stats` after a send → `replies: 1`, cost = reply + title cost; unknown id → 404; a deleted chat → 404.
  - Update `chats.test.ts:25` and `db.test.ts:70` fixtures, which seed messages with `insertMessage`, so they also `recordUsage` the same costs; the expectations stay the same.
- [ ] **Step 2: Run** `npx vitest run server/test/statsRoutes.test.ts server/test/chats.test.ts server/test/db.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Mount at `app.route('/api/stats', statsRoutes(deps))`; add the chat stats route to `routes/chats.ts`.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(server): stats API; chat totals from the usage log`.

---

### Task 7: Web helpers, route, sidebar link, API client

**Files:**
- Create: `web/src/lib/stats.ts`, `web/src/lib/stats.test.ts`
- Modify: `web/src/lib/route.ts`, `web/src/lib/route.test.ts`, `web/src/components/Sidebar.tsx`, `web/src/api.ts`

**Interfaces:**
- Produces:
  - `Route` gains `{ page: 'stats' }`; `parseHash('#/stats')`.
  - `api.stats(range: StatsRange, tz: string): Promise<StatsResponse>`; `api.chatStats(id: string): Promise<ChatStats>`.
  - In `web/src/lib/stats.ts`:
    ```ts
    export const RANGES: { id: StatsRange; label: string }[];  // All time, Year, Month, Week, Today
    export function loadRange(): StatsRange;                    // localStorage 'openchat.stats.range', default 'all', try/catch
    export function saveRange(r: StatsRange): void;
    export function compactNumber(n: number): string;           // 950 → '950', 184_000 → '184k', 12_400_000 → '12.4M'
    export function formatPercent(rate: number | null): string;  // 0.413 → '41%', null → '—'
    export function formatSeconds(ms: number | null): string;    // 900 → '0.9s', null → '—'
    export function formatChange(cur: number, prev: number | null): string | null; // (112,100) → '▲ 12%', (88,100) → '▼ 12%', prev 0/null → null
    export function heatLevel(replies: number, max: number): 0 | 1 | 2 | 3 | 4; // 0 → 0; else ceil(4 * replies / max)
    export function heatColumns(days: HeatDay[]): (HeatDay | null)[][]; // weeks of 7 (Sun→Sat); null pads after today
    export function emptyChatStats(): ChatStats;
    ```
- Sidebar footer order: Model Library, Stats (`#/stats`), Settings.

- [ ] **Step 1: Write failing tests** in `stats.test.ts` for each helper using the example values above, plus `heatColumns` of 8 days starting on a Sunday → 2 columns, the second with 1 day and 6 `null`s. Add `parseHash('#/stats')` → `{ page: 'stats' }` to `route.test.ts`.
- [ ] **Step 2: Run** `npx vitest run web/src/lib` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, plus `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): stats helpers, route and sidebar link`.

---

### Task 8: Stats page

**Files:**
- Create: `web/src/pages/Stats.tsx`, `web/src/components/stats/StatTiles.tsx`, `Heatmap.tsx`, `UsageChart.tsx`, `ModelRows.tsx`, `FeaturePanels.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: `api.stats`, every helper from Task 7, `StatsResponse`.
- `Stats` takes no props; it reads the range with `loadRange()` and the zone with `Intl.DateTimeFormat().resolvedOptions().timeZone`, and refetches when the range changes.

Layout follows the approved mockup (`stats-page-v2.html` in the spec's mockup folder; the spec describes it): `.page` / `.page-inner` (widen to ~960px for this page), heading row with the segmented range control, the 8 tiles in a 4-column grid that wraps to 2 under 700px, the heatmap panel ("always last 12 months"), the chart panel with a Cost · Tokens · Messages switch and a legend, the "By model" expandable rows (all collapsed; ▸/▾; `aria-expanded`), then Features used and Biggest chats (Cost · Length switch; each title links to `#/chat/<id>`), then the tracking-since footnote when `trackingSince` is set. Tile sub-lines and the model-row grid use exactly the fields and wording the spec lists. Colours come only from the existing CSS variables; heat shades are `color-mix(in srgb, var(--accent) N%, var(--border))` at 25/50/75/100%. Tooltips use the native `title` attribute (date · N replies · $X). Loading shows the previous data or "Loading…"; an error shows `.error-text`.

- [ ] **Step 1: Implement** the components and wire `{route.page === 'stats' && <Stats />}` into `App.tsx`.
- [ ] **Step 2: Verify in the browser.** `preview_start` the dev server (create `.claude/launch.json` with `npm run dev` if missing), send two replies from two models, open `#/stats`, and check: tiles show non-zero values; switching to Today and back refetches (network panel shows `range=today`); a model row expands; the heatmap has today's square shaded; Biggest chats opens the chat; no console errors. Check dark theme and a 375px width (no horizontal scroll). Take a screenshot.
- [ ] **Step 3: Run** `npm run typecheck` and `npx vitest run` — PASS.
- [ ] **Step 4: Commit** `feat(web): stats page`.

---

### Task 9: Per-chat popover

**Files:**
- Create: `web/src/components/ChatStatsPopover.tsx`
- Modify: `web/src/components/ChatView.tsx:297-300`, `web/src/styles.css`

**Interfaces:**
- Consumes: `api.chatStats`, `emptyChatStats`, `formatCost`, `compactNumber`, `formatPercent`.
- `ChatStatsPopover({ chatId: string | null; totalCost: number; refreshToken: number })` renders the "Total $X ▾" button (always, `$0.00` when nothing has been spent) and the panel.

- [ ] **Step 1: Implement.** Replace the conditional `Total` span in the header with the popover component, passing `detail?.chat.totalCost ?? 0` and a token that changes whenever ChatView reloads its detail after a reply. On open: if `chatId` is null use `emptyChatStats()` with no request **(Review Focus 5)**, else fetch `api.chatStats(chatId)`. Rows and order as the spec lists (Cost; Tokens "X (in / out)"; Cache "N% hit · M% miss" plus a two-part bar; Saved by cache; Replies "N (K models)"; Web searches; Avg prompt size). Close on outside `mousedown` and on Escape; `aria-expanded` on the button.
- [ ] **Step 2: Verify in the browser:** on `#/`, the header shows "Total $0.00 ▾" and the popover shows zeros (no `/stats` request in the network panel). In a chat with replies, the numbers match the Stats page for that chat; they update after another reply; outside click and Escape close it. Take a screenshot.
- [ ] **Step 3: Run** `npm run typecheck` and `npx vitest run` — PASS.
- [ ] **Step 4: Commit** `feat(web): per-chat stats popover`.
