# Usage Stats — Design Spec

**Date:** 2026-10-16
**Status:** Decisions approved in conversation (pending spec review)
**Builds on:** `docs/superpowers/specs/2026-10-14-openchat-design.md`, `docs/superpowers/specs/2026-10-14-compare-and-remember-design.md`, `docs/superpowers/specs/2026-10-16-web-search-design.md`

## Purpose

Show the user where their tokens and money go: lifetime and recent totals, how each model is used and how it performs, how well prompt caching works, and how each chat did. Today the app only shows a per-reply cost and a per-chat total.

## Decisions made in conversation

- **All the suggested stats are wanted:** spend over time, tokens over time, per-model totals and performance, cache hits and misses, web searches, feature usage, biggest chats, and an activity heatmap.
- **A new Stats page**, linked in the sidebar footer between **Model Library** and **Settings**.
- **Page layout:** lifetime-style headline tiles at the top, then the activity heatmap, then a usage-over-time chart, then a **per-model breakdown as expandable rows** sorted from most- to least-used, then two small panels (Features used, Biggest chats). The user picked expandable rows over model cards and a table.
- **Activity heatmap like Claude Code's `/stats`:** one small square per day, darker for busier days.
- **Time range buttons** on the Stats page: All time, Year, Month, Week, Today. Everything on the page follows the range **except the heatmap**, which always shows the last 12 months.
- **Per-chat stats live in a popover** opened by clicking the chat header's total. Nothing extra is on screen until clicked; clicking away closes it. The user picked this over inline chips and a toggleable strip.
- **The popover button always shows**, including in a brand-new chat with nothing sent, where every number is 0.

Mockups the user approved are in `.superpowers/brainstorm/1056-1792216974/content/` (`stats-page-v2.html` is the final page; `chat-header.html` option C is the popover). They are not committed (`.superpowers/` is git-ignored); this document is the source of truth.

## Out of scope

- Budgets, spending alerts or limits.
- Exporting stats (CSV etc.).
- Custom date ranges or a date picker beyond the five buttons.
- Clicking a heatmap day or chart bar to filter the page.
- Per-message stats beyond what the reply meta line already shows.
- Fetching OpenRouter's account-level usage or credit balance.

---

## The usage log

### Why a new table

Stats can't be computed from `messages` alone:

1. Deleting a chat deletes its messages (`ON DELETE CASCADE`), so lifetime totals would shrink.
2. Title generation (`server/src/title.ts`) and memory suggestions (`server/src/memorySuggest.ts`) call models but record nothing.
3. A reply that fails before any text arrives is never saved, so error rates can't be counted.
4. Cache, reasoning and timing numbers aren't captured anywhere.

### Table: `usage_events`

One row per OpenRouter generation call. **Never deleted** — not by deleting a chat, not by anything else. `chat_id` is a plain column with no foreign key, so a deleted chat's rows stay and simply no longer link to a chat.

| Column | Meaning |
|---|---|
| `id` | primary key |
| `created_at` | ms timestamp when the call started (`now()`) |
| `purpose` | `'reply'` (a chat reply, single or compare), `'title'`, `'memory'` |
| `chat_id` | chat it belongs to; null for `'memory'` |
| `message_id` | the saved assistant message, when there is one |
| `run_id` | groups the calls of one user action: every slot of one comparison shares it; a single reply has its own |
| `kind` | for replies: `'send'`, `'edit'`, `'regenerate'` (Regenerate and Retry both use the regenerate endpoint); null otherwise |
| `compare` | 1 when the reply was part of a comparison |
| `model_id` | model called |
| `prompt_tokens`, `completion_tokens` | as reported |
| `cached_tokens` | prompt tokens read from cache |
| `cache_write_tokens` | prompt tokens written to cache, where reported |
| `reasoning_tokens` | reasoning share of completion tokens, where reported |
| `cost` | USD as reported (already includes search fees) |
| `cache_savings` | USD saved by cached tokens, estimated at call time (see below); null when unknown |
| `web_search` | 1 when web search was on for this reply |
| `web_searches` | number of searches (same rule as `messages.web_searches`) |
| `attachments` | files on the user message this reply answers, for `send`/`edit` runs; 0 otherwise |
| `first_token_ms` | ms from sending the request to the first content or reasoning chunk; null if none arrived |
| `duration_ms` | ms from sending the request to the end of the stream (or failure) |
| `status` | `'complete'`, `'stopped'` (user stopped / client disconnected), `'error'` (failed, with or without partial text) |
| `backfilled` | 1 for rows created from old messages (see Backfill) |

Indexes on `created_at`, `(chat_id)`, and `(model_id)` — the builder can adjust these to the queries.

Message rows keep working exactly as now; `messages.status` stays `'complete' | 'stopped'`. The event's `'error'` vs `'stopped'` split is new and only lives in the log: if the abort signal fired it's `'stopped'`, otherwise a failure is `'error'`.

### What OpenRouter reports

The stream's final `usage` chunk is expected to carry `prompt_tokens_details.cached_tokens`, `prompt_tokens_details.cache_write_tokens` (some providers) and `completion_tokens_details.reasoning_tokens`. **Before building, run a small probe** against a few models (one Anthropic, one OpenAI, one DeepSeek or Gemini), as the web-search work did, to confirm the field names and record the findings in the plan. Missing fields are stored as null, never 0.

`openrouter.complete()` currently returns only text. It must also return usage (send `usage: { include: true }`, as the stream does) so title and memory calls can be logged.

### Cache savings

Cached tokens are billed at a discount. `cache_savings = cached_tokens × (prompt price − cache read price)` using the model's per-token prices from the cached catalog at call time. This needs the catalog to also keep OpenRouter's `pricing.input_cache_read`. If either price is unknown, `cache_savings` is null. "Saved" totals add up non-null values only.

### Where rows are written

- `streamReply` (`server/src/generate.ts`) and each slot of `streamComparison` (`server/src/compare.ts`): one row per call, written when the call ends — complete, stopped or failed — including failures with no text (which today leave no trace). The route passes `kind` and, for comparisons, one shared `run_id`.
- `generateTitle` (`server/src/title.ts`): one `'title'` row per attempt that reached OpenRouter, with the chat's id.
- `suggestMemory` (`server/src/memorySuggest.ts`): one `'memory'` row per attempt that reached OpenRouter.
- A call that never reached OpenRouter (no API key) writes no row.

### Backfill

On first start after this ships, a migration copies every existing assistant message into `usage_events` once: `purpose 'reply'`, its chat, message, model, tokens, cost, `web_search` (from the parent user message), `web_searches`, `status` (`'complete'` or `'stopped'`), `created_at`, `backfilled = 1`, and its own `run_id`. Everything the old data doesn't have stays null (`kind`, cache, reasoning, timing, savings) and `compare = 0`. Deleted chats can't be recovered.

The Stats page shows a quiet footnote: "Cache, speed, error and feature stats are tracked from <date of first non-backfilled event>." Averages and rates are computed only over rows that have the field, and show "—" when no row in the range has it.

---

## Stats page

Route `#/stats`, page component alongside `ModelLibrary` and `Settings`. Sidebar footer order: Model Library, **Stats**, Settings.

### Time range

A segmented control top-right next to the "Stats" heading: **All time · Year · Month · Week · Today**. Default: All time. The choice is remembered in `localStorage` (`openchat.stats.range`).

My call: ranges are rolling, in the viewer's local time — Year = last 365 days, Month = last 30 days, Week = last 7 days, Today = since local midnight. Day boundaries everywhere (heatmap, chart, streaks) are the browser's local time zone; the browser tells the server its zone.

### Tiles (follow the range)

Eight tiles in a 4-column grid (wrapping on narrow screens):

1. **Cost** — total; sub-line compares with the previous period of the same length ("▲ 12% vs previous 30 days"); no comparison for All time. For Today, the previous period is yesterday from midnight to the same time of day, so a half-finished day isn't compared with a full one (my call).
2. **Tokens** — total; sub-line "X in · Y out".
3. **Messages** — number of replies; sub-line "across N chats" (chats that had a reply in the range, including deleted ones).
4. **Cache hit rate** — cached ÷ prompt tokens over rows that report cache data; sub-line "saved ~$X".
5. **Web searches** — total searches; sub-line the cost of replies that searched.
6. **Avg first token** — mean `first_token_ms` of replies; sub-line average output speed (completion tokens ÷ (duration − first token), in tok/s).
7. **Active days** — days with at least one reply in the range ("22 / 30"); sub-line current streak and longest streak (consecutive local days with a reply; the current streak counts today or, if nothing yet today, ending yesterday). Streaks are always lifetime, not range-limited.
8. **Top model** — model with the most replies; sub-line its share of replies.

"Replies" means `purpose = 'reply'` rows that produced a reply: status `'complete'`, or `'stopped'`/`'error'` with a saved message (partial text). Calls that failed with no text don't count as replies anywhere (Messages tile, heatmap, active days, streaks, Top model, model row counts, Biggest chats by length, popover Replies), so a burst of retries after a 402/429 doesn't inflate them. They do count in cost, tokens, and the Errors / stopped share, whose base is every reply call. (My call.) Cost and token tiles include title and memory calls.

### Activity heatmap (always last 12 months)

53 columns × 7 rows (weeks × weekdays), squares in five shades of the accent colour by replies that day (empty, then four buckets scaled to the busiest day). Hovering a square shows a tooltip: date, replies, cost. Month labels along the top are a builder's nicety.

### Usage over time (follows the range)

A bar chart with a small switch: **Cost · Tokens · Messages**. One bar per bucket: All time and Year → per month; Month and Week → per day; Today → per hour. Each bar stacks chat replies (accent) and background calls — titles and memory — (lighter accent), with a legend. Hover shows the bucket's values. Plain HTML/SVG; no chart library (the app has none).

### By model (follows the range)

Expandable rows sorted by number of replies, most first; models with only background calls sort after. Every row starts collapsed. Collapsed row: ▸ model name (library name, else catalog name, else the id), a bar showing replies relative to the top model, "N replies · $X".

Expanded, a 4-column grid: Tokens, Cache hit, First token, Output speed, Avg cost/reply, Reasoning tokens, Errors / stopped (share of reply calls with `'error'` / `'stopped'`), Searches.

My call: a model's row includes its title and memory calls in cost and tokens; reply counts and per-reply averages use replies only.

### Features used (follows the range)

- **Compare mode** — number of comparison runs.
- **Web search** — replies with web search on.
- **Attachments** — files sent (counted once per `send`/`edit` run).
- **Regenerated / edited** — regenerate and edit runs.
- **Input : output tokens** — ratio of prompt to completion tokens.

These come only from non-backfilled rows (the footnote covers it).

### Biggest chats (follows the range)

Top 5 existing chats by **Cost** or **Length** (switch; length = number of reply calls in the range). Deleted chats are left out because they can't be opened. Clicking a chat opens it.

### Empty state

With no rows in the range, tiles show 0 or "—", the chart and model list show "No usage in this range", and the heatmap still renders (empty).

---

## Per-chat popover

- The chat header (`ChatView.tsx`) keeps the title on the left. On the right, "Total $X ▾" becomes a button and is **always shown** — `$0.00` in a brand-new chat or one where nothing has been sent.
- Clicking opens a small panel anchored under it. Clicking outside or pressing Escape closes it.
- Contents, all for this chat across every branch (edited and regenerated replies were paid for), including its title call:
  - Cost
  - Tokens (in / out)
  - Cache: hit % · miss % with a two-part bar
  - Saved by cache
  - Replies (and how many distinct models replied)
  - Web searches
  - Avg prompt size (mean prompt tokens of replies)
- In a new chat everything reads 0 (or "—" for rates).
- The numbers refresh after each reply finishes.

My call: the chat total (header and sidebar `ChatSummary.totalCost`) moves to the usage log so it matches the popover and includes title cost. This makes old totals unchanged (backfill equals the message costs) and new totals slightly higher by the title call.

---

## API

My call on shapes; the builder may adjust names.

- `GET /api/stats?range=all|year|month|week|today&tz=<IANA zone>` → everything the page needs in one response: tiles (with previous-period cost), heatmap days (always 12 months), chart buckets, model rows (with expanded fields), feature counts, biggest chats, and the tracking-since date.
- `GET /api/chats/:id/stats` → the popover numbers. 404 for an unknown chat.

Aggregation happens in SQL on the server.

## Testing

- Server: rows written for complete, stopped, failed-with-text and failed-without-text replies, compare slots sharing a `run_id`, title and memory calls; chat deletion leaves rows; backfill runs once and matches message totals; each aggregation (ranges, previous period, buckets, streaks, cache rate over reporting rows only, savings null handling); the OpenRouter client parses the new usage fields and `complete()` returns usage.
- Web: range and bucket helpers, number formatting, route parsing for `#/stats`.

## Left to the builder

- Component breakdown, CSS, exact colours of the heatmap shades (from the accent), tooltip style.
- Index choices and exact SQL.
- Whether stats responses are cached or computed per request (the data is small; per request is fine).
- How the browser passes its zone and how the server buckets by it.
