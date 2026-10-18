# Data tab and spending limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabbed Settings with a Data tab (storage, clean up, export, four deletes, real deletion), then optional calendar-period spending limits enforced server-side on every paid path.

**Architecture:** Server: `server/src/dataStore.ts` (storage, clean up, deletes, `purgeDeleted`), `server/src/zip.ts` (streaming store-only zip writer with ZIP64), `server/src/exportData.ts` (export entries), `server/src/limits.ts` (periods, spend, `checkSpend`) and routes `/api/data/*`, `/api/settings/limits`. Web: `Settings.tsx` becomes a tab shell over `settings/GeneralTab.tsx`, `MemoryTab.tsx`, `DataTab.tsx`; `components/SpendNotice.tsx` and `components/ErrorText.tsx` show the 80% notice and limit errors with a link.

**Tech Stack:** Hono, better-sqlite3 (dbstat available), Node 24 (`zlib.crc32`), React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-data-limits-and-polish-design.md` (pieces 3 and 4).

## Global Constraints

- Every model call goes through OpenRouter; server only on 127.0.0.1, local Host names only.
- Keep each file's existing line endings (all files touched here are LF).
- Commits `feat(web): …` / `feat(server): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never run delete/reset against `data/openchat.db`; tests use `:memory:` or temp files; browser checks use `OPENCHAT_DB` in the scratchpad and `OPENCHAT_PORT` ≠ 3000.
- Limits use calendar periods (day from midnight, week from Monday 00:00, month from the 1st) in the stored time zone; do not reuse `rangeWindow`/rolling code from `statsTime.ts`.
- Running work is never interrupted by a limit.
- No paid API calls.

## Review Focus

1. Deleting a chat whose word is in the FTS index: the old FTS segment still holds the token until merged → `purgeDeleted` runs FTS `optimize`; byte test greps both db and wal files (Task 2).
2. Delete videos while a clip renders → 409 with a message, nothing deleted (Task 3).
3. Export of a thread whose title has `/ \ : * ?` or is duplicated → sanitized, unique zip paths (Task 4).
4. Week boundary on a Sunday night / DST change, and month rollover in Dec → correct Monday 00:00 and Jan 1 resets (Task 6).
5. A rendering clip's estimated price counts toward the limit, so two clips back to back can't both slip under (Task 7).

---

### Task 1: Hash routes for Settings tabs

**Files:** Modify `web/src/lib/route.ts`; Test `web/src/lib/route.test.ts` (create).

**Interfaces — Produces:** `Route` settings variant `{ page: 'settings'; tab: SettingsTab; section: string | null }`, `type SettingsTab = 'general' | 'memory' | 'data'`, `SPENDING_LIMITS_HREF = '#/settings/general/limits'` (in `shared/limits.ts`, created here as a stub constant file).

- [ ] Test: `parseHash('#/settings')` → tab `general`, section null; `'#/settings/data'` → data; `'#/settings/general/limits'` → section `limits`; `'#/settings/bogus'` → general.
- [ ] Implement, run `npx vitest run web/src/lib/route.test.ts`, commit.

### Task 2: Real deletion (secure_delete, checkpoint, FTS purge)

**Files:** Modify `server/src/db.ts` (`secure_delete = ON` in `openDb`), create `server/src/dataStore.ts`, modify `server/src/routes/chats.ts` delete route; Test `server/test/dataStore.test.ts`.

**Interfaces — Produces:** `purgeDeleted(db: DB): void` — `INSERT INTO messages_fts(messages_fts) VALUES('optimize')` then `PRAGMA wal_checkpoint(TRUNCATE)`.

- [ ] Test `secure delete leaves no marker bytes`: temp-file DB, chat with message `qzxmarker7731` + an attachment containing it, delete via `DELETE /api/chats/:id` (app over that db), then bytes of `openchat.db` and `openchat.db-wal` (if present) do not contain the marker; FTS search for the marker returns 0 rows. Confirm it fails before the change.
- [ ] Implement; route calls `purgeDeleted` after `deleteChat`. Commit.

### Task 3: Storage, clean up, deletes and reset (server)

**Files:** `server/src/dataStore.ts`, create `server/src/routes/data.ts`, register `/api/data` in `server/src/app.ts`, types in `shared/types.ts`; Test `server/test/dataRoutes.test.ts`.

**Interfaces — Produces:**
- `StorageUsage { total: number; parts: { messages; uploads; images; videos; reclaimable; other: number } }` (bytes). total = db + wal + `*.mp4` in mediaDir; messages = SUM(length(content)+length(sources)); uploads = attachments not on an assistant message; images = attachments on assistant messages; reclaimable = freelist_count×page_size + wal size; other = total − rest (≥0).
- `storageUsage(deps): StorageUsage`; `cleanUp(db)`: checkpoint TRUNCATE, VACUUM, checkpoint TRUNCATE.
- `DeleteTarget = 'chats' | 'images' | 'videos' | 'all'`; `deleteData(deps, target): { chatIds: string[] }` returns deleted thread ids.
- Routes: `GET /api/data/storage`, `POST /api/data/cleanup` → StorageUsage, `POST /api/data/delete {target, confirm:'DELETE'}` → `{ ok, chatIds }`.

- [ ] Tests: storage parts reflect an uploaded attachment, generated image, clip file; delete `chats` keeps image/video threads, memories, usage_events; `images` / `videos` likewise; `videos` refuses with 409 "still rendering" when an unfinished job's thread exists and removes clip files + finished `video_jobs` otherwise; `all` empties every table (usage_events, media_events, memories, settings incl. api_key & spending limits, models, media_models, caches, video_jobs) and mediaDir clips, also refuses while rendering; missing/wrong confirm → 400; cleanup leaves freelist 0.
- [ ] Implement (`all` keeps `usage_backfill_done` so the backfill never reruns); every delete ends with `purgeDeleted`. Commit.

### Task 4: Streaming zip export

**Files:** create `server/src/zip.ts`, `server/src/exportData.ts`, route `GET /api/data/export` in `routes/data.ts`; Tests `server/test/zip.test.ts`, `server/test/export.test.ts`.

**Interfaces — Produces:**
- `ZipEntry { name: string; data: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>; size?: number }`; `zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncGenerator<Uint8Array>` — store-only, UTF-8 names (flag bit 11), data descriptors (bit 3), ZIP64 extras when a size/offset ≥ 0xFFFFFFFF, ZIP64 EOCD when needed.
- `exportEntries(deps): AsyncGenerator<ZipEntry>` — `openchat-export/data.json` (`{ exportedAt, chats: SELECT * chats, messages: SELECT * messages, attachments (metadata only), mediaGenerations, memories, settings }`; settings = all rows except `api_key`), `chats|images|videos/<safe title>-<id8>.md` (active path, roles, model, attachments as relative links, note of other-branch count), `attachments/<id>/<safe filename>`, `videos/<messageId>.mp4`. Blobs loaded one id at a time (never a held iterator).
- [ ] Tests: zip round-trip parsed by a tiny reader in the test (local headers, central directory, CRC via `zlib.crc32`), unicode names; export contains data.json without the key, a Markdown file per thread with sanitized unique names, attachment bytes and clip bytes match.
- [ ] Route: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="openchat-export-YYYY-MM-DD.zip"`, body `Readable.toWeb(Readable.from(zipStream(...)))`. Commit.

### Task 5: Settings tabs and Data tab (web)

**Files:** modify `web/src/pages/Settings.tsx` (shell + tab bar, passes `section`), create `web/src/pages/settings/GeneralTab.tsx`, `MemoryTab.tsx`, `DataTab.tsx`, `web/src/lib/dataPrefs.ts` (+ test), `web/src/lib/format.ts` `formatBytes(n)` (+ test), `web/src/api.ts`, `web/src/App.tsx`, `web/src/styles.css`.

**Interfaces — Produces:** `formatBytes(n: number): string` ("0 B", "512 KB", "12.3 MB", "1.20 GB"); `forgetChatPrefs(chatIds: string[])` (removes `openchat.compare.<id>`, `openchat.search.<id>`), `forgetAllPrefs()` (every `openchat.` key). Track A may add its own `forgetChatPrefs`; reconcile on merge.
- [ ] Tests for `formatBytes` and prefs helpers (fake localStorage).
- [ ] DataTab: storage stacked bar + rows, Clean up ("Working…"), Export link (`<a href="/api/data/export" download>`), three delete buttons and a separated danger "Delete all my data"; each opens a dialog where the input must equal `DELETE`; reset copy lists what goes and, when `apiKeySource === 'env'`, says the .env key stays. After deletes: forget prefs, `onChanged()` and refresh chats (App passes `onDataChanged`). Commit.

### Task 6: Limit periods and spend (server)

**Files:** create `server/src/limits.ts`, `shared/limits.ts`; settings in `server/src/settings.ts` + `shared/types.ts`; Test `server/test/limits.test.ts`.

**Interfaces — Produces:**
- `LimitPeriod = 'daily' | 'weekly' | 'monthly'`; `SpendingLimits { daily: LimitSetting; weekly: LimitSetting; monthly: LimitSetting; timeZone: string }`, `LimitSetting { enabled: boolean; amount: number | null }` (setting key `spending_limits`, JSON; default all off, tz `UTC`).
- `periodBounds(period, now, tz): { start: number; resetsAt: number }`.
- `LimitStatus { period; amount; spent; start; resetsAt }`; `limitStatuses(db, now): LimitStatus[]` (enabled ones; spent = usage_events + media_events cost since start + estimated price of unfinished video_jobs).
- `checkSpend(db, opts?: { estimate?: number | null; now?: number }): void` throws `HttpError(429, limitMessage(...))`.
- `shared/limits.ts`: `LIMIT_LABELS` (`Today`, `This week (since Monday)`, `This month`), `LIMIT_ERROR = /spending limit (reached|would be exceeded)/i`, `SPENDING_LIMITS_HREF`.
- Message: `Daily spending limit reached ($5.00). It resets Saturday, October 18 at 12:00 AM.` / with estimate: `This would go over your weekly spending limit ($2.00 left of $10.00). It resets Monday, October 20 at 12:00 AM.`
- `SettingsView.spendingLimits`, `SettingsUpdate.spendingLimits` validated (amount > 0 finite when enabled, valid tz).
- [ ] Tests: daily/weekly/monthly bounds in `America/New_York` incl. Sunday 23:30 → Monday reset, DST, Dec→Jan; spent sums both tables only since start; under/over/estimate behaviour and message text; settings round trip and validation. Commit.

### Task 7: Enforce limits on every paid path

**Files:** `server/src/routes/generate.ts` (send, regenerate, edit before `claim`), `server/src/imageGen.ts` (estimate from `estimateImageCost(model, settings, null).cost`), `server/src/videoJobs.ts` (estimate from `videoPrice`), `server/src/title.ts` (skip silently), `server/src/memorySuggest.ts` (short 429 message), `GET /api/settings/limits` → `LimitStatus[]`; Test `server/test/limitsEnforce.test.ts`.

- [ ] Tests: over daily limit → send/regenerate/edit/compare 429 with the message and nothing saved; image/video refused when estimate exceeds what's left, accepted when it fits; rendering clip estimate counts; title not generated (no usage row) when over; memory suggest 429 short message; a running stream is not affected. Commit.

### Task 8: Limits UI (web)

**Files:** GeneralTab spending-limit section (`id="limits"`, scrolled into view for section `limits`), `web/src/components/SpendNotice.tsx`, `web/src/components/ErrorText.tsx`, `web/src/lib/limits.ts` (+ test: `noticeFor(statuses, dismissed)` picks the ≥80% one not dismissed for its `start`), wire into ChatView, ImageThread, VideoThread, RememberBox error spots.
- [ ] Save sends `timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone`; labels from `LIMIT_LABELS`; shows spent so far.
- [ ] Commit.

### Task 9: Verify

- [ ] `npx vitest run`, `npx tsc --noEmit` pass.
- [ ] Browser check on port 3123 with scratchpad `OPENCHAT_DB`: tabs and URLs, storage, clean up, export download, typed-DELETE dialogs, reset, limits save and an over-limit error with link. Leave a hand-over note in the shared notes folder.
