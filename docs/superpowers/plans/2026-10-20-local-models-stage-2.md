# Local Models, Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local replies record and show load time, time to first token and tokens/sec; the Stats page splits Local from OpenRouter; spending limits never block local models; loading, offline and not-installed states read plainly; local models take images and PDFs (as extracted text).

**Architecture:** Local clients report `loadMs` and `generationMs` on their `usage` event and answer `loadState(model)`. A wrapper in the provider layer turns a slow first token into a `status` stream event, which every streaming route forwards as an SSE `status` frame. Timings land in new `usage_events` and `messages` columns; `computeStats` derives the Local/OpenRouter split from model ids. Spending checks move behind `isLocalModelId`. PDF text is extracted with `unpdf`, cached by attachment hash in a new `pdf_text` table, and sent to local models as a `<file>` text part. A new availability route feeds a web context that greys out offline and missing models.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, Vitest. One new dependency: `unpdf`.

**Spec:** `docs/superpowers/specs/2026-10-20-local-models-design.md` (read it first; this plan covers "Build stages" item 2). Stage 1's plan, `docs/superpowers/plans/2026-10-20-local-models-stage-1.md`, describes the provider layer and fake server this builds on.

## Global Constraints

- OpenRouter behavior, stored rows, stats and costs must not change. Existing tests keep passing unless a task says otherwise. New columns are nullable and left `NULL` for OpenRouter calls.
- New dependency: `unpdf` pinned exactly to `1.8.1` (MIT, no dependencies, published 2026-08-13). No other new dependencies.
- Timings: loading message after **2,000 ms** without a first event when the server says the model isn't loaded; waiting message after **5,000 ms** otherwise. Load time shows on a reply and counts toward Stats averages only when it is at least **1,000 ms** (`COLD_LOAD_MS`); below that the model was already in memory.
- `loadState` requests time out after **1,500 ms**, like every listing request. LM Studio's pre-chat model listing times out after **10,000 ms** (it runs while LM Studio may be busy loading).
- Copy, verbatim (stage 1's `Can't reach…` and `{server name} couldn't run this model: …` stay as they are):
  - Loading: `Loading {model} into memory…` · Waiting: `Waiting for the model…`
  - Model gone from its server: `{model} isn't installed on {server name} any more.`
  - Server dropped mid-reply: `Lost the connection to {server name} at {host:port}.`
  - Badges: `Offline`, `Not installed`, `Turned off`
  - Composer when the chosen model can't reply: `{model} is offline.` / `{model} isn't installed on {server name} any more.` / `{server name} is turned off in Settings.`
  - New PDF without text, sent to a local model (400): `{filename}: This PDF has no readable text.` Inside a prompt, an earlier such PDF becomes `This PDF has no readable text.` in its `<file>` block.
  - Reply details: `{n} tok/s` (one decimal under 10, whole number otherwise), `{s} s to first token`, `loaded in {s} s` (seconds to one decimal).
  - Stats: section `Local vs OpenRouter`, rows `Local` and `OpenRouter` reading `{n} replies · {tokens} tokens`; table `Local model speed` with columns `Model`, `Speed`, `First token`, `Cold load`. Model rows gain a `Load time` detail for local models.
- Never touch the user's `data/openchat.db`, and leave port 5173 to the user's own dev server. Browser checks run a built copy: `npm run build`, then the server with `OPENCHAT_DB=.superpowers/verify/openchat.db` and `OPENCHAT_PORT=3100` (it serves `dist/`), opened at `http://localhost:3100`.
- Commit after every task, ending each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Not in this plan (later stages)

- Web search for local models (stage 3).
- Discussion moderator note, same-server warning, one-model tip, one-at-a-time Compare (stage 4). Discussion turns do get the loading status and the limit rule here.

## Review Focus

1. **A model already in memory that answers in 300 ms** must never flash "Loading…", and a `loadState` answer that arrives after the first token must be dropped. Test in Task 5.
2. **The server is killed mid-reply:** the reply ends with `Lost the connection to…`, the partial text is saved as stopped, and no raw `terminated` / `fetch failed` / `ECONNRESET` text appears. Test in Task 7.
3. **A reached limit in a mixed Compare:** the OpenRouter column fails with the limit message, the local column replies; an all-OpenRouter Compare is still refused with 402 before anything is saved; a Discussion is refused only when the next speaker is an OpenRouter model. Test in Task 4.
4. **A long PDF sent to a local model with a small window** must trigger the overflow question from its extracted text, not slip past on the page-count estimate. Test in Task 8.
5. **Rows from before stage 2, and OpenRouter rows,** have `NULL` timing columns: Stats numbers for them are unchanged, and no reply shows `0 tok/s`, `NaN` or an empty `·`. Test in Tasks 3 and 9.

---

### Task 1: Client timings and load state

**Files:**
- Modify: `test/fakeLocalServer.ts`, `test/fakeLocalServer.test.ts`
- Modify: `server/src/openrouter.ts` (`Usage` gains two fields; `parseUsage` sets them `null`)
- Modify: `server/src/providers/types.ts`, `server/src/providers/ollama.ts`, `server/src/providers/openaiCompat.ts`, `server/src/providers/lmstudio.ts`
- Test: `server/test/ollamaClient.test.ts`, `server/test/lmstudioClient.test.ts`

**Interfaces:**
- Produces:
  - `Usage` gains `loadMs: number | null; generationMs: number | null` (both `null` from OpenRouter).
  - `interface LoadState { loaded: boolean; contextWindow: number | null }` in `providers/types.ts`.
  - `LocalClient.loadState(model: string, contextWindow?: number): Promise<LoadState | null>` — `null` when the server can't say (OpenAI-compatible servers, or any failure / timeout). Never throws.
  - Fake server: `FakeModel.loadMs?: number` (pause before the first chunk the first time an unloaded model is used, after which it is loaded); `FakeReply.evalMs?: number` (reported generation time, default 100); `startFakeLocalServer` option `listDelayMs?: number` (delays LM Studio's `GET /api/v1/models`). Ollama flavor answers `GET /api/ps` with `{ models: [{ name, model, context_length }] }` for loaded models, `context_length` being the last `num_ctx` used. LM Studio's load call sleeps `loadMs` and returns `load_time_seconds: loadMs / 1000`. The script takes `--load-ms <n>`, applied to its default models.
- Ollama: `loadMs = load_duration / 1e6`, `generationMs = eval_duration / 1e6` from the final line (rounded). `loadState` from `/api/ps`: loaded only when listed **and** its `context_length` (when present) equals `contextWindow` (Ollama reloads on a different `num_ctx`).
- LM Studio: when the prepare step loads the model, `loadMs` = `load_time_seconds * 1000`, or the load call's measured duration if absent; `null` when no load happened. `generationMs` stays `null` (Task 2 derives it). `loadState` from `/api/v1/models`: `loaded_instances.length > 0`, `contextWindow` from `loaded_instances[0].config.context_length`. The pre-chat listing uses `PREPARE_TIMEOUT_MS = 10_000`.

- [ ] **Step 1: Write the failing tests:**
  - Ollama: `qwen3:1.7b` with `loadMs: 300`, reply with `evalMs: 250` → usage has `loadMs` ≥ 300 and `generationMs: 250`; second request has `loadMs` < 50. `loadState('qwen3:1.7b', 16384)` is `{ loaded: false, … }` before the first chat and `{ loaded: true, contextWindow: 16384 }` after; `loadState('qwen3:1.7b', 8192)` after it is `loaded: false`. Closed server → `loadState` resolves `null`.
  - LM Studio: an unloaded model with `loadMs: 200` → usage `loadMs` ≈ 200 (±50); a loaded one → `loadMs: null`. `loadState` reports the loaded window. With `listDelayMs: 2000` the load request is still sent before the chat request (proves the 10 s pre-chat timeout).
  - OpenAI-compatible: `loadState` resolves `null`.
- [ ] **Step 2: Run** `npx vitest run server/test/ollamaClient.test.ts server/test/lmstudioClient.test.ts test/fakeLocalServer.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement**, fixing every compile error the two new `Usage` fields cause with `null`.
- [ ] **Step 4: Run** the same command, then `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): local clients report load and generation time`

---

### Task 2: Record timings on usage events and replies

**Files:**
- Modify: `server/src/db.ts` (SCHEMA + `migrate`)
- Modify: `server/src/usage.ts`, `server/src/messages.ts`, `server/src/fork.ts`
- Modify: `server/src/generate.ts`, `server/src/compare.ts`, `server/src/discussion/turn.ts`
- Modify: `shared/types.ts`, `shared/localModels.ts`
- Test: `server/test/usage.test.ts`, `server/test/providers.test.ts`, `server/test/fork.test.ts`, `server/test/db.test.ts`

**Interfaces:**
- Consumes: `Usage.loadMs`, `Usage.generationMs` (Task 1).
- Schema: `usage_events.load_ms INTEGER`, `usage_events.generation_ms INTEGER`; `messages.first_token_ms INTEGER`, `messages.load_ms INTEGER`, `messages.generation_ms INTEGER`. Added in SCHEMA and through the `PRAGMA table_info` pattern in `migrate`.
- Produces:
  - `shared/localModels.ts`: `const COLD_LOAD_MS = 1_000`.
  - `shared/types.ts`: `interface ReplyTiming { firstTokenMs: number | null; loadMs: number | null; tokensPerSec: number | null }`; `Message` gains `timing: ReplyTiming | null` (null for OpenRouter replies, user messages and old rows: when all three columns are `NULL`).
  - `server/src/usage.ts`: `generationMsFor(modelId: string, usage: Usage | null, firstTokenMs: number | null, durationMs: number | null): number | null` — `null` for OpenRouter ids; for local ids `usage.generationMs`, else `durationMs - firstTokenMs` when both are known and positive. `UsageRow` gains `loadMs`, `generationMs`. `recordUsage` writes `load_ms = usage.loadMs` and `generation_ms = generationMsFor(...)`.
  - `insertMessage` accepts `firstTokenMs?`, `loadMs?`, `generationMs?` (default `null`); the row mapping builds `timing`, with `tokensPerSec = completion_tokens / (generation_ms / 1000)` when both are known and `generation_ms > 0`.
  - `fork.ts`'s `INSERT INTO messages … SELECT` column lists include the three new columns (stage 1 lost `context_dropped` there once).
- `streamReply`, `runSlot` in `compare.ts` and `streamTurn` call `timer.finish()` once at the end of the stream and pass the same numbers to both the saved message and `recordUsage`.

- [ ] **Step 1: Write the failing tests:**
  - `usage.test.ts`: `generationMsFor('openai/gpt-4o', …)` is `null`; for a local id with `usage.generationMs: 400` → 400; with `null` and timings 300/1300 → 1000; with `firstTokenMs: null` → `null`. `recordUsage` round-trips `loadMs` and `generationMs` through `loadUsageRows`.
  - `providers.test.ts`: a send to the fake Ollama `qwen3:1.7b` (`loadMs: 1200`, `evalMs: 500`, `completionTokens: 20`) saves a reply whose `timing` is `{ loadMs: ≥1200, tokensPerSec: 40, firstTokenMs: number }`, and the usage row has the same `loadMs` and `generationMs: 500`. A Compare slot and a Discussion turn record timings too. An OpenRouter reply (scripted `deps.openrouter.streamChat`) has `timing: null` and `NULL` columns.
  - `fork.test.ts`: forking a chat keeps a reply's `timing`.
  - `db.test.ts`: a database built from the previous SCHEMA migrates and old messages read `timing: null`.
- [ ] **Step 2: Run** `npx vitest run server/test/usage.test.ts server/test/providers.test.ts server/test/fork.test.ts server/test/db.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): record load time and speed for local replies`

---

### Task 3: Stats split between Local and OpenRouter

**Files:**
- Modify: `server/src/stats.ts`, `shared/types.ts`
- Test: `server/test/stats.test.ts`

**Interfaces:**
- Consumes: `UsageRow.loadMs`, `UsageRow.generationMs` (Task 2), `COLD_LOAD_MS`, `isLocalModelId`.
- Produces:
  - `interface SourceTotals { replies: number; tokens: number }`; `StatsResponse` gains `sources: { local: SourceTotals; openrouter: SourceTotals }` (over the range; replies counted as today's `counted`, tokens over every call).
  - `ModelStats` gains `local: boolean` and `avgLoadMs: number | null` (mean `loadMs` over reply rows with `loadMs >= COLD_LOAD_MS`; `null` when none).
  - `outputTokensPerSec` uses `generationMs` as a row's streaming time when it is set, else today's `durationMs - firstTokenMs`.
- Rows built by `server/test/usageHelpers.ts` gain `loadMs: null, generationMs: null` defaults.

- [ ] **Step 1: Write the failing tests:**
  - Two local replies (`local:ab12cd34:qwen3:1.7b`, 100 completion tokens each, `generationMs` 1000 and 4000, `loadMs` 3000 and 200) and one OpenRouter reply: `sources.local` is `{ replies: 2, tokens: … }`, `sources.openrouter.replies` is 1; the local model's `outputTokensPerSec` is 40 (200 tokens / 5 s), `avgLoadMs` 3000 (the 200 ms one is warm), `local: true`; the OpenRouter model has `local: false`, `avgLoadMs: null`.
  - Review Focus 5: every existing assertion in `stats.test.ts` passes unchanged with the new columns `null`, and an OpenRouter-only fixture has `sources.local` equal to `{ replies: 0, tokens: 0 }`.
- [ ] **Step 2: Run** `npx vitest run server/test/stats.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): stats split local from OpenRouter use`

---

### Task 4: Spending limits never block local models

**Files:**
- Modify: `server/src/routes/generate.ts`, `server/src/compare.ts`, `server/src/routes/discussions.ts`, `server/src/discussion/turn.ts`, `server/src/discussion/summary.ts`, `server/src/title.ts`, `server/src/memorySuggest.ts`, `server/src/limits.ts`
- Test: `server/test/limitsEnforce.test.ts`

**Interfaces:**
- Produces:
  - `limits.ts`: `spentSince` leaves out `usage_events` rows whose `model_id` starts with `local:` (they cost 0 already; this makes it explicit).
  - `routes/generate.ts`: `claim(chat, modelIds)`. When every model is OpenRouter, `checkSpend(db)` as today (402 before anything is saved). When every model is local, no check. When mixed, `spendBlock(db)`'s message (or `null`) is passed to `streamComparison` as `limitMessage?: string`.
  - `compare.ts`: `CompareOptions.limitMessage?: string` — each OpenRouter slot sends `slot-error` with that message without calling the provider and logs no usage; local slots run normally.
  - `discussion/turn.ts`: `turnSpeaker(db: DB, chatId: string): DiscussionParticipant` (the `nextSpeaker(...)` choice `streamTurn` already makes, now shared). The turn route calls `checkSpend(db)` only when `turnSpeaker`'s model is not local.
  - `summary.ts`, `memorySuggest.ts`: the spend check runs only for an OpenRouter model. `title.ts`: the `spendBlock` check moves after the title model is chosen and applies only when it isn't local.
- Image and video spend checks are unchanged.

- [ ] **Step 1: Write the failing tests** (a daily limit of $1 with $2 already logged against an OpenRouter model):
  - Sending to a local model streams the fake's reply; regenerate and edit too.
  - Compare between a local and an OpenRouter model: the local slot ends with `slot-done`, the OpenRouter slot with `slot-error` whose message starts `Daily spending limit reached`; `deps.openrouter.streamChat` was never called.
  - Compare between two OpenRouter models: 402, and no user message saved (Review Focus 3).
  - A Discussion whose next speaker is local takes its turn; one whose next speaker is an OpenRouter model gets 402.
  - A local-only chat gets a title from the fake; a Discussion summary and a memory suggestion with a local model succeed; with an OpenRouter model they are refused as today.
  - A local usage row inserted with `cost: 0.5` doesn't count toward `limitStatuses(db)[0].spent`.
- [ ] **Step 2: Run** `npx vitest run server/test/limitsEnforce.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): spending limits only apply to OpenRouter models`

---

### Task 5: Loading and waiting status while a local model starts

**Files:**
- Create: `server/src/providers/loadingStatus.ts`
- Modify: `server/src/openrouter.ts` (`StreamEvent` gains a member), `server/src/providers/index.ts`, `server/src/generate.ts`, `server/src/compare.ts`, `server/src/discussion/turn.ts`, `shared/types.ts`, `shared/localModels.ts`
- Test: `server/test/loadingStatus.test.ts`, `server/test/providers.test.ts`

**Interfaces:**
- Consumes: `LocalClient.loadState` (Task 1).
- Produces:
  - `StreamEvent` gains `{ type: 'status'; status: 'loading' | 'waiting' }`.
  - `withLoadingStatus(events: AsyncGenerator<StreamEvent>, loadState: () => Promise<LoadState | null>, o?: { loadingAfterMs?: number; waitingAfterMs?: number }): AsyncGenerator<StreamEvent>` — defaults 2,000 and 5,000. Until the inner stream's first event: at `loadingAfterMs` it calls `loadState` once; if that resolves `{ loaded: false }` **before** the first event, it yields `status: 'loading'`. At `waitingAfterMs`, if no event and no `loading` yet, it yields `status: 'waiting'`. After the first inner event every timer is cleared and events pass through unchanged. Returning or throwing from the consumer calls `return()` on the inner generator, so Stop still aborts the request. Implement by racing the pending `next()` promise against the timers; don't buffer events.
  - `chatProvider` wraps a local model's `streamChat` with it (`loadState(name, contextWindow)`); `complete` is untouched.
  - `shared/localModels.ts`: `statusMessage(status: 'loading' | 'waiting', model: string): string` → the Global Constraints copy.
  - SSE: `streamReply` and `streamTurn` send `status` `{ message }` (`StreamStatus`); `runSlot` sends `status` `{ slot, message }` (`CompareSlotStatus`). `model` is `displayNameOf(db, modelId)`. Status events are not saved and not counted as a first token.

- [ ] **Step 1: Write the failing tests:**
  - `loadingStatus.test.ts` (timings 20 / 60 ms, scripted inner generators): an inner stream whose first event comes at 100 ms with `loadState` → `{ loaded: false }` yields `loading` then the events, and no `waiting`; with `loadState` → `null` it yields `waiting` only; with `{ loaded: true }` it yields `waiting` at 60 ms; an inner stream that answers at 5 ms yields no status (Review Focus 1); a `loadState` that resolves after the first event yields nothing; calling `return()` on the wrapper calls the inner generator's `return()`.
  - `providers.test.ts` (real defaults): the fake Ollama with `qwen3:1.7b` at `loadMs: 2600` → the SSE stream for a send has a `status` frame `{ message: 'Loading qwen3:1.7b into memory…' }` before the first `delta`; a second send (now loaded) has none.
- [ ] **Step 2: Run** `npx vitest run server/test/loadingStatus.test.ts server/test/providers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): say when a local model is loading into memory`

---

### Task 6: LM Studio's loaded window in the overflow check

**Files:**
- Modify: `server/src/providers/index.ts`, `server/src/contextCheck.ts`, `server/src/routes/generate.ts`, `server/src/routes/context.ts`, the continue route in `server/src/routes/chats.ts`
- Test: `server/test/contextCheck.test.ts`

**Interfaces:**
- Consumes: `LocalClient.loadState` (Task 1).
- Produces:
  - `loadedWindows(deps: Deps, modelIds: string[]): Promise<Map<string, number>>` in `providers/index.ts` — for models on **LM Studio** servers only (Ollama takes the window from each request; OpenAI-compatible servers can't say), the loaded window from `loadState`; models not loaded, unknown or unreachable are left out.
  - `contextOverflow(db, o)` takes `windows?: Map<string, number>`; a model's window is `windows.get(id) ?? modelContextLength(db, id)`. The overflow it reports carries that window.
  - The generation routes and the continue route `await loadedWindows(...)` before their overflow check; `GET` context (`routes/context.ts`) uses it for the context ring's `contextLength`.

- [ ] **Step 1: Write the failing tests:** an LM Studio fake with `qwen3-8b` loaded at a 4,096 window while My models says 16,384, and a chat of ~6,000 estimated tokens: send → 409 with `overflow[0].window === 4096`; the same chat with the model unloaded → no 409 (it will be loaded at 16,384); the context route reports `contextLength: 4096` while loaded; an Ollama model is unaffected.
- [ ] **Step 2: Run** `npx vitest run server/test/contextCheck.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(server): the overflow check uses the window LM Studio loaded`

---

### Task 7: Plain errors and model availability

**Files:**
- Modify: `server/src/providers/localHttp.ts`, `server/src/providers/ollama.ts`, `server/src/providers/openaiCompat.ts`, `server/src/providers/lmstudio.ts`
- Modify: `server/src/localDetect.ts`, `server/src/routes/localServers.ts`, `shared/types.ts`
- Modify: `test/fakeLocalServer.ts`
- Test: `server/test/ollamaClient.test.ts`, `server/test/lmstudioClient.test.ts`, `server/test/localServerRoutes.test.ts`, `server/test/providers.test.ts`

**Interfaces:**
- Produces:
  - `guardBody(body: ReadableStream<Uint8Array>, server: { name: string; baseUrl: string }, signal?: AbortSignal): ReadableStream<Uint8Array>` in `localHttp.ts` — a read error that isn't the caller's abort becomes `LocalServerError('Lost the connection to {name} at {host}.', 0)`. Ollama's and the OpenAI-compatible chat streams read through it.
  - Not installed: Ollama's `/api/chat` answering 404, and LM Studio's prepare step finding a successful listing without the model, throw `LocalServerError("{model} isn't installed on {server name} any more.", 404)`. `{model}` is the server's model name.
  - Fake server: `FakeReply.cutAfter?: number` — destroys the socket after that many chunks.
  - `type LocalAvailability = 'ready' | 'offline' | 'missing' | 'off'` in `shared/types.ts`.
  - `modelAvailability(db: DB): Promise<Record<string, LocalAvailability>>` in `localDetect.ts` — every local model in My models: `off` when its server is turned off, `offline` when its server doesn't answer, `missing` when the server answers without it, else `ready`. One `probeServers` call; no detection run.
  - `GET /api/local-servers/availability` → that record.

- [ ] **Step 1: Write the failing tests:**
  - Ollama and OpenAI-compatible: `reply({ text: ['a', 'b', 'c'], cutAfter: 1 })` → the stream rejects with `Lost the connection to Ollama at 127.0.0.1:<port>.`; aborting mid-stream still rejects with `AbortError`.
  - Through `POST /messages` (Review Focus 2): the `error` frame's message is the lost-connection copy, `partial.status` is `stopped` with the first chunk's text, and the frame contains none of `terminated`, `fetch failed`, `ECONNRESET`.
  - After `setModels([])` on the fake, sending to `qwen3:1.7b` gives `qwen3:1.7b isn't installed on Ollama any more.`; same for LM Studio.
  - `GET /availability` with one running fake (two library models, one then dropped via `setModels`), one closed server and one turned-off server → `ready`, `missing`, `offline`, `off` for the matching ids.
- [ ] **Step 2: Run** `npx vitest run server/test/ollamaClient.test.ts server/test/lmstudioClient.test.ts server/test/localServerRoutes.test.ts server/test/providers.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): plain errors for dropped and missing local models, and an availability route`

---

### Task 8: PDFs and images for local models

**Files:**
- Modify: `package.json` (`"unpdf": "1.8.1"`, exact), `package-lock.json`
- Create: `server/src/pdfText.ts`
- Modify: `server/src/db.ts` (table), `server/src/dataStore.ts` (`ALL_TABLES` gains `pdf_text`), `server/src/prompt.ts`, `server/src/context.ts`, `server/src/contextCheck.ts`, `server/src/generate.ts`, `server/src/attachments.ts`, `server/src/routes/generate.ts`
- Modify: `web/src/lib/attachments.ts` and its test (drop the local-PDF refusal)
- Modify: `test/helpers.ts` (PDF fixtures)
- Test: `server/test/pdfText.test.ts`, `server/test/providers.test.ts` (replaces the stage 1 refusal test at line 81), `server/test/contextCheck.test.ts`, `server/test/dataStore.test.ts`

**Interfaces:**
- Schema: `pdf_text (key TEXT PRIMARY KEY, text TEXT NOT NULL)`. `key` is the attachment's `hash`, or `id:<attachment id>` when the hash is `NULL`. A derived cache: wiped with the rest, not exported.
- Produces (`server/src/pdfText.ts`):
  - `extractPdfText(data: Buffer): Promise<string>` — `unpdf`'s `getDocumentProxy` + `extractText(…, { mergePages: true })`, trimmed; `''` for no text **or** a PDF that fails to parse.
  - `ensurePdfText(db: DB, attachmentIds: string[]): Promise<void>` — extracts and stores every PDF among them not cached yet.
  - `cachedPdfText(db: DB, attachmentId: string): string | null` — `null` when not extracted.
  - `pathPdfIds(db: DB, chatId: string, parentId: string | null): string[]` — PDF attachment ids on the active path ending at `parentId`.
- `prompt.ts`: `AttachmentOptions` gains `pdfText?: (id: string) => string | null`. When given, each PDF becomes `{ type: 'text', text: '<file name="{name}">\n{text}\n</file>' }`, with `This PDF has no readable text.` as the text when it is `''` or `null`, instead of a `file` part. `promptFor` passes it for local models and sends no `plugins` for them.
- `context.ts`: the estimate takes the same optional `pdfText`; a cached text counts as `textTokens(text)`, else the page estimate as today. `contextOverflow` passes it for local models.
- Generation routes, when any chosen model is local: `await ensurePdfText(db, [...pathPdfIds(...), ...new attachment ids])` before `requireViewable`.
- `requireViewable`: the stage 1 PDF refusal goes; a **new** PDF whose cached text is `''` refuses with 400 `{filename}: This PDF has no readable text.` when any chosen model is local. Earlier PDFs are never refused (they get the in-prompt note).
- Images need no new code (stage 1 converts them); this task pins them with tests.
- Fixtures in `test/helpers.ts`: `pdfWithText(text: string): Buffer` (one page, Helvetica, a valid xref) and `pdfWithoutText(): Buffer` (one empty page).

- [ ] **Step 1: Write the failing tests:**
  - `pdfText.test.ts`: `extractPdfText(pdfWithText('Quarterly revenue rose 12%'))` contains that sentence; `pdfWithoutText()` and `Buffer.from('%PDF-1.4 garbage')` give `''`; `ensurePdfText` twice extracts once (spy or check the row count); two attachments with the same hash share a row.
  - `providers.test.ts`: a PDF sent to the fake Ollama `gemma3:1b` reaches it as a message whose `content` contains `<file name="report.pdf">` and the sentence; a PDF attached earlier while chatting with an OpenRouter model reaches a later local reply the same way (it was dropped in stage 1); `pdfWithoutText()` sent to a local model is 400 `scan.pdf: This PDF has no readable text.` and saves nothing; the same PDF sent to an OpenRouter model still goes as a `file` part with the plugin.
  - Images: an Ollama model with `vision: true` receives the uploaded PNG in `images`; an LM Studio vision model receives an `image_url` part; `gemma3:1b` (no vision) is 400 `gemma3:1b can't view images.`.
  - `contextCheck.test.ts` (Review Focus 4): a 2-page PDF holding ~6,000 tokens of text, sent to a local model with a 4,096 window, → 409 overflow; the page estimate alone (2,000) would have let it through.
  - `dataStore.test.ts`: "Delete all my data" empties `pdf_text`.
  - `web/src/lib/attachments.test.ts`: a PDF draft with a local model chosen is no longer blocked.
- [ ] **Step 2: Run** `npm install` then `npx vitest run server/test/pdfText.test.ts server/test/providers.test.ts server/test/contextCheck.test.ts server/test/dataStore.test.ts web/src/lib/attachments.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: local models read PDFs as extracted text`

---

### Task 9: Reply timings and loading status (web)

**Files:**
- Create: `web/src/lib/timing.ts`, `web/src/lib/timing.test.ts`
- Modify: `web/src/api.ts` (stream handlers gain `onStatus`), `web/src/components/ThinkingIndicator.tsx`, `web/src/components/ChatView.tsx`, `web/src/components/CompareColumns.tsx`, `web/src/components/MessageItem.tsx`, `web/src/components/discussion/DiscussionView.tsx` (and wherever it renders a streaming turn)

**Interfaces:**
- Consumes: `Message.timing` (Task 2), SSE `status` frames (Task 5).
- Produces:
  - `timingParts(t: ReplyTiming | null): string[]` — in order `{n} tok/s`, `{s} s to first token`, `loaded in {s} s` per Global Constraints; each part only when its number is known and positive, load only at `COLD_LOAD_MS` or more; `[]` for `null`.
  - Stream handlers: single replies and Discussion turns `onStatus(message: string)`; Compare `onStatus(slot: number, message: string)`. Pending reply state keeps the latest `status` string, cleared when the first delta or reasoning arrives.
  - `ThinkingIndicator` takes `status?: string`; when set it shows that text (with the seconds counter) instead of `Thinking…`.
  - `MessageItem`'s `msg-head` and `CompareColumns`' finished column head add each `timingParts` entry as `· {part}`.

- [ ] **Step 1: Write the failing tests:** `timingParts({ firstTokenMs: 812, loadMs: 3140, tokensPerSec: 41.6 })` → `['42 tok/s', '0.8 s to first token', 'loaded in 3.1 s']`; `tokensPerSec: 7.46` → `'7.5 tok/s'`; `loadMs: 300` leaves the load part out; `{ firstTokenMs: null, loadMs: null, tokensPerSec: null }` and `null` → `[]` (Review Focus 5); `tokensPerSec: 0` is left out.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/timing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS. Then serve the built copy (Global Constraints) with `npm run fake-local -- --flavor ollama --port 11434 --load-ms 3000` running, add `qwen3:1.7b`, send a message: the reply shows `Loading qwen3:1.7b into memory…` before the text and `… tok/s · … s to first token · loaded in 3.0 s` after. Screenshot both.
- [ ] **Step 5: Commit** `feat(web): show load time and speed on local replies`

---

### Task 10: Offline, Not installed and Turned off (web)

**Files:**
- Create: `web/src/lib/availability.ts`, `web/src/lib/availability.test.ts`, `web/src/components/AvailabilityContext.ts`
- Modify: `web/src/api.ts` (`modelAvailability()`), `web/src/App.tsx`, `web/src/pages/ModelLibrary.tsx`, `web/src/components/ModelPicker.tsx`, `web/src/components/ChatView.tsx`, `web/src/components/discussion/DiscussionSetup.tsx`

**Interfaces:**
- Consumes: `GET /api/local-servers/availability` (Task 7).
- Produces:
  - `availabilityLabel(a: LocalAvailability | undefined): string | null` → `Offline`, `Not installed`, `Turned off`, or `null` for `ready` / unknown.
  - `unavailableReason(models: LibraryModel[], ids: string[], availability: Record<string, LocalAvailability>): string | null` — the composer copy from Global Constraints for the first chosen model that isn't ready; `null` when all are ready or unknown.
  - `AvailabilityContext` (same pattern as `FilePanelContext.ts`) holding `Record<string, LocalAvailability>`, and `useAvailability()`.
  - `App.tsx` fetches availability when My models has a local model: after models load or change, and on window `focus`. A failed fetch keeps the last value.
- UI: My models rows show the badge next to the source badge; `ModelPicker` items for unavailable models are `disabled` with the label in their `<small>` (single and Compare lists); `ChatView` passes `unavailableReason(...)` as the composer's `disabledReason`; `DiscussionSetup` disables those `<option>`s and adds the label to their text.

- [ ] **Step 1: Write the failing tests** for `availabilityLabel` (all four values and `undefined`) and `unavailableReason` (one model offline → `qwen3:1.7b is offline.`; a missing one names its server `Ollama`; turned off → `Ollama is turned off in Settings.`; a Compare where only the second is missing names it; all ready → `null`).
- [ ] **Step 2: Run** `npx vitest run web/src/lib/availability.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS. In the browser with the fake running and both default models in My models: stop the fake and refocus the window → both rows say `Offline`, the picker greys them out, the composer says `qwen3:1.7b is offline.`; restart it with only `qwen3:1.7b` → `gemma3:1b` reads `Not installed`; turn the server off in Settings → `Turned off`. Screenshot each.
- [ ] **Step 5: Commit** `feat(web): offline and not-installed local models`

---

### Task 11: Local stats on the Stats page (web)

**Files:**
- Create: `web/src/components/stats/LocalStats.tsx`
- Modify: `web/src/lib/stats.ts`, `web/src/lib/stats.test.ts`, `web/src/pages/Stats.tsx`, `web/src/components/stats/ModelRows.tsx`

**Interfaces:**
- Consumes: `StatsResponse.sources`, `ModelStats.local`, `ModelStats.avgLoadMs` (Task 3).
- Produces:
  - `sourceLine(t: SourceTotals): string` → `12 replies · 34K tokens` (`1 reply` singular; tokens via the existing `compactNumber`).
  - `formatSpeed(tokPerSec: number | null): string` → `42 tok/s` / `7.5 tok/s` / `—`.
  - `LocalStats({ stats }: { stats: StatsResponse })` — renders nothing when `sources.local.replies === 0`; otherwise the `Local vs OpenRouter` section (the two rows with a share bar, styled like `ModelRows`) and the `Local model speed` table over `models.filter((m) => m.local)` with `formatSpeed`, `formatSeconds(avgFirstTokenMs)` and `formatSeconds(avgLoadMs)`.
  - `Stats.tsx` places it after `UsageChart`. `ModelRows` adds `Load time` (`formatSeconds(m.avgLoadMs)`) to the details of local models.

- [ ] **Step 1: Write the failing tests** for `sourceLine` (`{ replies: 1, tokens: 950 }` → `1 reply · 950 tokens`; `{ replies: 12, tokens: 34_000 }` → `12 replies · 34K tokens`, matching what `compactNumber` prints) and `formatSpeed`.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/stats.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the section and row styles of `ModelRows.tsx`.
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS. In the browser after Task 9's replies, the Stats page shows the split and the speed table; a range with no local use shows neither. Screenshot.
- [ ] **Step 5: Commit** `feat(web): local vs OpenRouter on the Stats page`

---

### Task 12: Stage check with real Ollama

**Files:** none (verification only; fixes go in commits of their own)

- [ ] **Step 1:** Run `npm test` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 2:** The controller serves the built copy as in Global Constraints (its own database, never `data/openchat.db`, not on 5173). Against the user's real Ollama (`gemma3:1b`, `qwen3:1.7b`), in the browser pane:
  - `ollama stop qwen3:1.7b`, then send: `Loading qwen3:1.7b into memory…` shows, the reply shows tok/s, first token and load time; a second send shows no loading text and no load time.
  - Confirm the real `/api/ps` reports `context_length` (or note that it doesn't, and that `loadState` then trusts the name alone).
  - Stats page: the Local vs OpenRouter split and the speed table show the replies.
  - Set a $0.01 daily limit with a logged OpenRouter cost over it (insert a usage row into the verify database): local sends still work.
  - Attach a text PDF to `gemma3:1b` and ask about it; attach a scanned (image-only) PDF and see `…: This PDF has no readable text.`
  - Stop Ollama (quit the tray app): My models says `Offline`, the picker greys out, the composer explains; start it again and refocus: back to normal. Kill Ollama mid-reply: `Lost the connection to Ollama at localhost:11434.`
  - Neither model takes images, so image input is covered only by the fake server; say so in the report.
  Screenshots go to the user. Note anything that differs from the fake server.
- [ ] **Step 3:** Fix what the check finds, each with a failing test against the fake server first where possible, and commit.
