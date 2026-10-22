# Local Models, Stage 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discussions and Compare work well with local models: Compare runs models that share a local server one at a time, Discussion setup gives the one-model tip and the shared-server warning, the moderator check and a "not steering" note cover small local moderators, and a Discussion turn whose local model can't hold the discussion pauses and asks instead of running silently.

**Architecture:** One shared helper, `sharesServer(modelIds)`, tells both the web and the server when two or more different local models sit on one server (the server id is inside the model id). `streamComparison` groups slots by local server and runs each group in order while the groups and OpenRouter slots run at the same time. The turn route gets the chat routes' overflow check (409 with `overflow`, `allowOverflow` to go ahead, `contextDropped` on the saved turn), estimated from the turn's real prompt. The client loop gains an `overflow` pause that shows a Discussion version of the overflow dialog. The moderator's missed tool calls are counted on the `discussions` row, and the turn that makes it two in a row is remembered, so the note shows once and survives a reload.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-local-models-design.md` (read it first; this plan covers "Build stages" item 4 and the "Discussions" and "Compare" sections, plus the Discussion part of "Context window", which stage 1 deferred). Stages 1–3's plans (`docs/superpowers/plans/2026-10-20-local-models-stage-1.md`, `…-stage-2.md`, `2026-10-21-local-models-stage-3.md`) describe the provider layer, the chat overflow check and the fake local server this builds on.

## Global Constraints

- OpenRouter-only Compares and Discussions behave exactly as today: same concurrency, same frames, same stored rows. Existing tests keep passing unless a task says otherwise.
- "Shares a server" means two or more **different** local model ids with the same server id (from `parseLocalModelId`). The same model twice, OpenRouter models, and local models on different servers never count.
- Copy, verbatim:
  - Discussion setup tip (any participant's model is local): `Tip: one local model can play every participant. Give each one different instructions.`
  - Discussion setup warning (participants' models share a server), under the participant list: `These models share one server, so each turn may wait while the next model loads.`
  - Moderator note, shown once after the turn that made it two misses in a row: `The moderator isn't choosing speakers, so the normal order is being used.`
  - Compare note above the live compare replies (the compare's models share a server): `Local models on the same server reply one at a time.`
  - A Compare slot waiting for its turn shows the status `Waiting for {previous model's display name} to finish…`.
  - Discussion overflow (409 error text and dialog title): `This discussion is longer than {model} can remember.` Dialog body: `It's {participant}'s turn next, so the discussion is paused.` Buttons: `Stay paused` (focused), `End discussion`, `Send anyway`. Under the buttons: `Send anyway lets this turn and later ones go ahead while you watch. Their replies are marked where earlier messages were dropped.`
  - The dropped-messages note on a turn is the chat's: `Earlier messages were dropped because the chat is longer than this model's memory.`
- A moderator "miss" is a turn that finished (`complete`) without a valid tool call (`readToolCall` returned `null`, or no call at all). A valid `pass_to` or `end_discussion` resets the count to 0. Failed or stopped turns leave the count alone.
- The Discussion overflow estimate counts the turn's real prompt (`buildDiscussionPrompt`'s messages, plus the moderator's tools as JSON) at 4 characters per token (`textTokens`), never below the speaker's last own turn's `promptTokens + completionTokens` plus the counted text after it, and asks when `used + OVERFLOW_MARGIN > window`. Window: LM Studio's loaded window (`loadedWindows`), else `modelContextLength`.
- Never touch the user's `data/openchat.db`, and leave port 5173 to the user's own dev server. Browser checks run a built copy: `npm run build`, then the server with `OPENCHAT_DB=.superpowers/verify/openchat.db` and `OPENCHAT_PORT=3100`, opened at `http://localhost:3100`.
- Keep each file's existing line endings (the repo is mixed LF/CRLF).
- Commit after every task, ending each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Not in this plan

- Overflow checks for Discussion summaries (the user picks that model; spec: "Summaries … work with any model, as today").
- Summarize-and-continue for Discussions (a discussion has no continued-chat note); the dialog offers Stay paused / End discussion / Send anyway instead.
- Ordering Discussion turns across servers (turns already run one at a time).

## Review Focus

1. **Stopping a Compare while a same-server model waits its turn:** the waiting slots never start, aren't logged as usage, and no `slot-error` is sent; the running slot is saved as `stopped` as today. Test in Task 1.
2. **One local model failing in a same-server Compare** (offline, server error): the next model in that group still runs, and models on other servers are unaffected. Test in Task 1.
3. **"Send anyway" in a Discussion, then the loop keeps going:** the next turn that overflows doesn't ask again while the page is open (the loop sends `allowOverflow: true`), each such turn is saved with `contextDropped`, and reopening the discussion asks again. Test in Tasks 3 and 4.
4. **Moderator misses around an `end_discussion` and +2 turns:** a miss, then `end_discussion`, then +2 turns and one more miss is *not* two in a row; the note is set at most once per discussion even after more misses. Test in Task 2.
5. **Overflow when the turn route is refused for another reason:** an ended discussion, a turn already in flight, or a spending limit keeps its current error and status; the overflow check never runs for an OpenRouter speaker. Test in Task 3.

---

### Task 1: Shared-server helper and one-at-a-time Compare

**Files:**
- Modify: `shared/localModels.ts`, `server/src/compare.ts`
- Test: `shared/localModels.test.ts`, `server/test/compare.test.ts` (or a new `server/test/localCompare.test.ts` using the fake Ollama, styled like `localWebSearch.test.ts`)

**Interfaces:**
- Produces:
  - `localServerGroups(modelIds: string[]): string[][]` in `shared/localModels.ts` — the distinct local model ids grouped by server id, in first-appearance order, groups in first-appearance order; OpenRouter ids left out.
  - `sharesServer(modelIds: string[]): boolean` — some group has two or more ids.
  - `streamComparison`: slots whose models share a server run one after another in slot order; each group, and each OpenRouter slot, runs concurrently with the rest. At start, every queued slot gets a `status` frame with the waiting copy naming the slot just before it in its group. A slot whose turn comes after the request was aborted returns `null` without calling the provider, logging usage, or sending a frame.

- [ ] **Step 1: Write the failing tests:**
  - `localServerGroups(['local:a:x', 'or/m', 'local:b:y', 'local:a:z', 'local:a:x'])` → `[['local:a:x', 'local:a:z'], ['local:b:y']]`; `sharesServer` of that is `true`; of `['local:a:x', 'local:b:y', 'or/m']` and of `['local:a:x', 'local:a:x']` is `false`.
  - Compare between `qwen3:1.7b` and `gemma3:1b` on one fake Ollama (each reply with `delayMs`): every slot-1 `delta` frame comes after slot 0's `slot-done`; slot 1 got a `status` frame `Waiting for qwen3:1.7b to finish…` before slot 0 finished; both messages are saved.
  - Two fake servers, one model each: the two slots' deltas interleave (both requests reach their servers before either finishes).
  - Review Focus 2: the first same-server model hits `failNext(500, …)` → slot 0 `slot-error`, slot 1 still replies.
  - Review Focus 1: aborting the request while slot 0 streams → only one chat request reached the fake, one usage row, slot 0's partial saved `stopped`.
  - An OpenRouter slot (scripted `streamChat`) beside two same-server local slots streams before slot 0 finishes.
- [ ] **Step 2: Run** `npx vitest run shared/localModels.test.ts server/test/compare.test.ts` (plus the new file if made). Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Run `runSlot` per group in a `for … of` loop; keep the existing frame queue.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): local models on one server reply one at a time in Compare`

---

### Task 2: Local moderators and the "not steering" note (server)

**Files:**
- Modify: `server/src/db.ts` (migration), `server/src/discussion/store.ts`, `server/src/discussion/turn.ts`, `shared/types.ts`
- Test: `server/test/discussionStore.test.ts`, `server/test/discussionTurn.test.ts`

**Interfaces:**
- Produces:
  - `discussions` gains `moderator_misses INTEGER NOT NULL DEFAULT 0` and `moderator_note_after TEXT` (a message id), added the way `db.ts` adds columns today.
  - `DiscussionState` gains `moderatorNoteAfter: string | null` (the message after which the note shows); `discussionState` fills it.
  - `recordModeratorTurn(db: DB, chatId: string, messageId: string, valid: boolean): void` in `store.ts` — valid resets the count to 0; a miss adds 1 and, when the count reaches 2 and `moderator_note_after` is `NULL`, sets it to `messageId`.
  - `streamTurn` calls it after saving a `complete` moderator turn, before `settle`, so the `done` frame's `state` already carries the note.

- [ ] **Step 1: Write the failing tests:**
  - Store: with a server and `qwen3:1.7b` (`supportsTools: true`) and `gemma3:1b` (no tools) added as local models (as in `localWebSearch.test.ts`'s setup), creating a discussion whose moderator is `gemma3:1b` → 400 `The moderator needs a model that can use tools. Pick another model for it.`; moderator `qwen3:1.7b` → created; `gemma3:1b` as an ordinary participant → created.
  - Turn: a moderator discussion where the moderator answers with text and no tool twice → after the first, `state.moderatorNoteAfter` is `null`; after the second (the moderator's second turn), it equals that turn's message id, in the `done` frame and in `GET /api/discussions/:id`.
  - A moderator call `pass_to` with an unknown name counts as a miss; a valid `pass_to` between two misses means no note.
  - Review Focus 4: miss, then `end_discussion`, then `more-turns`, then one miss → no note; three misses in a row → the note stays on the second one.
  - A moderator turn that fails mid-stream doesn't change the count.
- [ ] **Step 2: Run** `npx vitest run server/test/discussionStore.test.ts server/test/discussionTurn.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Fix any web code that builds a `DiscussionState` literal (tests, fixtures) so typecheck passes.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): note when the moderator isn't choosing speakers`

---

### Task 3: The overflow check before a Discussion turn (server)

**Files:**
- Modify: `server/src/contextCheck.ts`, `server/src/routes/discussions.ts`, `server/src/discussion/turn.ts`
- Test: `server/test/discussionOverflow.test.ts` (new, fake Ollama), `server/test/contextCheck.test.ts`

**Interfaces:**
- Consumes: `buildDiscussionPrompt`, `moderatorTools`, `turnSpeaker`; `textTokens`; `loadedWindows`; `OVERFLOW_MARGIN`, `ContextOverflow`.
- Produces:
  - `discussionOverflow(db: DB, chatId: string, windows?: Map<string, number>): ContextOverflow | null` in `contextCheck.ts` — for the next speaker's model, by the Global Constraints estimate; `null` for OpenRouter models or an unknown window.
  - `discussionOverflowMessage(o: ContextOverflow): string` — `This discussion is longer than {displayName} can remember.`
  - `POST /api/discussions/:id/turn` takes an optional JSON body `{ allowOverflow?: boolean }` (no body still works; a non-boolean is 400 `allowOverflow must be true or false.`). After the existing checks (spend, in flight, ended, limit), for a local speaker it awaits `loadedWindows` and `discussionOverflow`; overflowing without `allowOverflow: true` → 409 `{ error, overflow: [o], speaker }` (`speaker` is the next participant's name), nothing saved, status still `active`. The in-flight mark is taken before the await and released if the check throws.
  - `streamTurn(c, deps, chatId, onFinish, o?: { contextDropped?: boolean })` — saves the turn with `contextDropped` when the route let an overflowing turn through.

- [ ] **Step 1: Write the failing tests** with the fake Ollama and `qwen3:1.7b` as both participants (window set small with the model's context window, e.g. 2,048):
  - `contextCheck.test.ts`: a discussion whose transcript is about 300 tokens fits; one about 1,500 tokens overflows a 2,048 window with `estimate` ≥ 1,500 and the speaker's model in the result; an OpenRouter speaker → `null`; a speaker whose last own turn reported `promptTokens: 1900` overflows even with a short transcript.
  - Route: overflowing turn → 409, body `overflow[0].modelId` is the speaker's model, `speaker` is its participant name, error is the discussion copy, no request reached the fake, no message saved; same with `{ allowOverflow: true }` → streams, saved message has `contextDropped: true`; a fitting turn → `contextDropped: false`.
  - `{ allowOverflow: 'yes' }` → 400.
  - Review Focus 5: an ended discussion that would overflow still answers 409 with the ended copy (no `overflow`); an OpenRouter speaker over a spending limit still answers 402; an OpenRouter speaker is never checked.
- [ ] **Step 2: Run** `npx vitest run server/test/discussionOverflow.test.ts server/test/contextCheck.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): ask before a Discussion turn outgrows a local model`

---

### Task 4: The Discussion page pauses and asks (web)

**Files:**
- Create: `web/src/components/discussion/DiscussionOverflowDialog.tsx`
- Modify: `web/src/lib/discussionLoop.ts` + test, `web/src/lib/discussion.ts` + test, `web/src/api.ts` (`streamDiscussionTurn`), `web/src/components/discussion/DiscussionView.tsx`, `web/src/components/discussion/DiscussionTranscript.tsx`

**Interfaces:**
- Consumes: the 409 `overflow` body and `allowOverflow` (Task 3); `DiscussionState.moderatorNoteAfter` (Task 2).
- Produces:
  - `LoopState` gains `overflow: { overflow: ContextOverflow[]; speaker: string } | null` and `allowOverflow: boolean` (both start `null`/`false`).
  - `LoopEvent` gains `{ type: 'turnOverflow'; overflow: ContextOverflow[]; speaker: string }` (→ `streaming: false`, mode `paused` when running, `overflow` set, `error` null) and `{ type: 'sendAnyway' }` (→ `allowOverflow: true`, `overflow: null`, mode `running` unless ended). `pause`, `resume` and `stopped` clear `overflow`; `resume` keeps `allowOverflow`.
  - `streamDiscussionTurn(id, h, signal, o?: { allowOverflow?: boolean })` posts `{ allowOverflow }` as JSON; its refused-request `onError` value carries `overflow?: ContextOverflow[]` and `speaker?: string` when the body has them.
  - `discussionOverflowTitle(overflow: ContextOverflow[]): string` and `discussionOverflowBody(participantName: string): string` in `lib/discussion.ts` (Global Constraints copy).
  - `DiscussionOverflowDialog({ overflow, speaker, onStayPaused, onEnd, onSendAnyway })`, styled like `ContextOverflowDialog` (same `modal-backdrop`/`modal card` markup, backdrop click = Stay paused). `speaker` comes from the 409 body.
  - `DiscussionView`: `onError` with `overflow` dispatches `turnOverflow` instead of `turnFailed`; End discussion calls the existing `stop()`; turns pass `allowOverflow: loop.allowOverflow`. The paused line `Paused. Press Resume to continue.` doesn't show while the dialog is open.
  - `DiscussionTranscript`: a turn with `contextDropped` shows the dropped-messages note under its body; after the message whose id is `detail.state.moderatorNoteAfter`, a `discussion-end muted` line with the moderator note.

- [ ] **Step 1: Write the failing tests** (`discussionLoop.test.ts`, `discussion.test.ts`):
  - running + `turnOverflow` → paused, `overflow` set, `nextAction` is `idle`; then `sendAnyway` → running, `allowOverflow: true`, `overflow: null`, `nextAction` is `turn`; then `turnOverflow` again is not expected (the server lets it through), but `pause` and `resume` keep `allowOverflow: true` (Review Focus 3); `initialLoop` starts with `allowOverflow: false`.
  - `stopped` after `turnOverflow` → ended, `overflow: null`.
  - `discussionOverflowTitle([{ displayName: 'qwen3:1.7b', … }])` → `This discussion is longer than qwen3:1.7b can remember.`; `discussionOverflowBody('Egg-Defender')` → `It's Egg-Defender's turn next, so the discussion is paused.`
- [ ] **Step 2: Run** `npx vitest run web/src/lib/discussionLoop.test.ts web/src/lib/discussion.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS. (Browser check is in Task 6.)
- [ ] **Step 5: Commit** `feat(web): pause a Discussion and ask when a local model can't hold it`

---

### Task 5: Setup tip, shared-server warning and the Compare note (web)

**Files:**
- Modify: `web/src/lib/discussion.ts` + test, `web/src/components/discussion/DiscussionSetup.tsx`, `web/src/components/CompareColumns.tsx`, `web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `sharesServer`, `isLocalModelId` (`shared/localModels.ts`, Task 1).
- Produces:
  - `setupNotes(modelIds: string[]): { tip: boolean; sharedServer: boolean }` in `lib/discussion.ts` — `tip` when any id is local; `sharedServer` is `sharesServer(modelIds)`.
  - `DiscussionSetup` uses it with every row's `modelOf(r)`: the tip and the warning are `muted small` paragraphs under the participant list (warning first), before the Order line.
  - `CompareColumns` takes an optional `note?: string`, shown in `compare-head` (the head renders when `title`, `onClose` or `note` is set). `ChatView` passes the Compare note to the live (pending) compare only, when `sharesServer` of its slots' model ids.

- [ ] **Step 1: Write the failing tests:** `setupNotes(['or/a', 'or/b'])` → both false; `setupNotes(['local:s:qwen3:1.7b', 'local:s:qwen3:1.7b'])` → tip only; `['local:s:qwen3:1.7b', 'local:s:gemma3:1b']` → both; `['local:s:qwen3:1.7b', 'local:t:gemma3:1b']` → tip only.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/discussion.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): local model tips for Discussions and the one-at-a-time Compare note`

---

### Task 6: Stage check

**Files:** none (verification only; fixes go in commits of their own)

- [ ] **Step 1:** Run `npm test` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 2:** Serve the built copy as in Global Constraints against the user's real Ollama (`qwen3:1.7b` with tools and thinking, `gemma3:1b` without tools), in the browser pane:
  - Discussion setup: picking `qwen3:1.7b` for both shows the tip and no warning; switching one to `gemma3:1b` shows the warning; `gemma3:1b` offers no Moderator box, `qwen3:1.7b` does.
  - A discussion with `qwen3:1.7b` moderating and two participants on `gemma3:1b`/`qwen3:1.7b`, turn limit 6: turns run; note whether the moderator calls `pass_to` (stage 1 saw it do so) and whether the "isn't choosing speakers" note appears; the load status shows while a model switches.
  - Overflow: set `qwen3:1.7b`'s context window low in My models (e.g. 2,048), run a few turns → the loop pauses with the dialog; `Stay paused` leaves it paused; `Send anyway` runs the turn with the dropped note and later turns go on without asking; reopening the discussion asks again. Set the window back afterwards.
  - Compare `qwen3:1.7b` and `gemma3:1b`: the note shows, the second column says `Waiting for qwen3:1.7b to finish…` until the first finishes.
  - Screenshots go to the user.
- [ ] **Step 3:** Fix what the check finds, each with a failing test against the fakes first where possible, and commit.
