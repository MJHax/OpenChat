# Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three small bugs from the 2026-10-17 review: video double-submit, endless clip download retry, stale per-chat browser keys.

**Architecture:** Server fixes live in `server/src/videoJobs.ts` (an in-memory per-thread claim, and a persisted "download failing since" time on `video_jobs`). The web fix adds one helper module that removes a chat's localStorage keys, called by the sidebar delete and later by the Data tab.

**Tech Stack:** Hono, better-sqlite3, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-data-limits-and-polish-design.md` (piece 1 only)

## Global Constraints

- Keep each file's existing line endings (all files touched here are LF).
- Schema changes: `CREATE TABLE IF NOT EXISTS` plus an additive migration in `server/src/db.ts`.
- Commit style `fix(server): …` / `fix(web): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No real API calls; tests use the scripted OpenRouter client.

## Review Focus

- A submit that fails at OpenRouter (4xx/5xx) must free the thread: the next request gets 202, not 409.
- A validation error after the claim (bad photo, no API key) must also free the thread.
- A download that fails then succeeds before 24 h must still complete normally (existing "retries a failed download" test keeps passing).
- A thread deleted while downloads keep failing: giving up still records the media event with `message_id` null.
- `forgetChatPrefs` must not throw when storage is unavailable.

---

### Task 1: Claim the thread before submitting a video

**Files:** Modify `server/src/videoJobs.ts`; Test `server/test/videoJobs.test.ts`

- [ ] Test `two simultaneous requests submit one clip`: make `submitVideo` wait ~20 ms, fire two `s.start(id)` with `Promise.all`, expect statuses sorted `[202, 409]` and `s.submitted` length 1.
- [ ] Test `a refused submit frees the thread`: `submitVideo` throws `OpenRouterError('nope', 400)` once → 400, then next start → 202.
- [ ] Run, see the first fail.
- [ ] Implement: module-level `const claimed = new Set<string>()`; the 409 check also tests `claimed.has(threadId)`; add right after the check, `try { … } finally { claimed.delete(threadId) }` around the rest (the DB row covers the thread once inserted).
- [ ] Run tests, commit `fix(server): claim a video thread before submitting so two tabs can't both pay`.

### Task 2: Give up on a clip download after 24 h

**Files:** Modify `server/src/db.ts` (column `download_failed_at INTEGER` on `video_jobs`, plus migration), `server/src/videoJobs.ts`; Test `server/test/videoJobs.test.ts`

- [ ] Test `gives up on a download that keeps failing for a day`: completed job with `usage(0.12)`, downloads fail; after ticks spanning just under 24 h message is still `generating` and no events; after passing 24 h since the first failure: message `status: 'error'`, `cost: 0.12`; `generations[id].error` contains `likely charged`; events `[{ status: 'complete', cost: 0.12 }]`; no `.mp4` or `.part` file; the thread accepts a new start (202).
- [ ] Run, see it fail.
- [ ] Implement: export `DOWNLOAD_GIVE_UP_MS = 24 * 60 * MIN`. In `finish`, wrap download + rename in try/catch; on error set `download_failed_at` to `at` if null, and if `at - download_failed_at >= DOWNLOAD_GIVE_UP_MS` settle as given up (event complete with cost = usage cost ?? estimate, job finished, message `error` with that cost, generation error "The clip finished, but it couldn't be downloaded for 24 hours, so OpenChat stopped trying. OpenRouter has likely charged for it."), else rethrow. A successful download clears nothing (job is finished).
- [ ] Rename the `never gives up` test's intent only if needed (it covers rendering, which still never gives up); update the poll comment.
- [ ] Run tests, commit `fix(server): stop retrying a clip download after a day and record its cost`.

### Task 3: Forget a chat's browser prefs when it is deleted

**Files:** Create `web/src/lib/chatPrefs.ts`, `web/src/lib/chatPrefs.test.ts`; Modify `web/src/lib/compare.ts`, `web/src/lib/search.ts` (export `compareKey`, `searchKey`), `web/src/components/Sidebar.tsx`

**Interfaces:** Produces `forgetChatPrefs(chatIds: string[]): void` — removes `openchat.compare.<id>` and `openchat.search.<id>` for each id; swallows storage errors. Track C's Data tab calls it for bulk deletes.

- [ ] Test: with an in-memory Storage holding keys for chats a, b and an unrelated key, `forgetChatPrefs(['a'])` leaves only b's keys and the unrelated one; with a throwing storage it does not throw.
- [ ] Run, see it fail; implement; run.
- [ ] Sidebar `remove`: after `api.deleteChat` succeeds, call `forgetChatPrefs([chat.id])`.
- [ ] Commit `fix(web): forget a chat's compare and web-search settings when it is deleted`.

### Task 4: Verify

- [ ] `npx vitest run` and `npx tsc --noEmit` both pass.
