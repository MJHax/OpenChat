# Discussion Pacing and Moderator Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make moderated discussions end when the moderator says so, let the moderator own the turn limit, and pace live discussions so the host can read along and step in.

**Architecture:** Server side, a moderator turn without a valid tool call gets one follow-up request with `tool_choice: 'required'` (text fallback), and a new `moderator_decides` flag replaces the turn limit with a 100-turn cap. Browser side, the discussion loop gains three holds (reveal, wait-for-me, typing), a pure reveal-rate helper drives a word-by-word reveal, and two browser preferences (reveal mode, wait-for-me) are set from the setup form and an options menu.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-discussion-pacing-design.md`

## Global Constraints

- Node.js 22.12+; no new dependencies (no animation library).
- Reveal: about 6 words per second; no reply takes more than about 10 seconds to appear (rate = max(6 words/s, words ÷ 10 s)); about 1 second beat after a reply has fully appeared.
- Hard cap: `MAX_TURN_LIMIT` (100) turns, also for "Let the moderator decide".
- Defaults: Show replies **Naturally**, After each reply **Keep going**; with a moderator, **Let the moderator decide**.
- The follow-up decision request goes through `chatProvider` to the moderator's own model, respects the turn's abort signal, and its usage is added to the moderator's message.
- Only turns that showed text get the beat and Wait-for-me; a silent moderator handoff flows straight through.
- Preferences live in `localStorage`, every read and write in try/catch, falling back to the defaults.
- Every rule of `docs/superpowers/specs/2026-10-18-discussion-tab-design.md` still holds (spending limits, private instructions, local-only stays local, opened discussions start paused).
- Run `npm test` and `npm run typecheck` before each commit.

## Review Focus

1. A moderator that answers the follow-up with neither a tool call nor a usable name/END: the turn is a miss (existing note and rotation), never an error or a stuck discussion. Pinned in Task 3.
2. Stop pressed while a natural reveal is still running: the full saved reply shows at once and no next turn starts. Pinned in Task 7 (manual check) and Task 5 (loop: `stopped` clears holds).
3. Host types, then clears the box without sending: the debate continues by itself. Pinned in Task 5.
4. **+2 turns** on an ended moderator-decides discussion: it becomes a normal limited discussion and can be extended again. Pinned in Task 4.
5. Blocked `localStorage` (private window): options fall back to Naturally/Keep going and changing them doesn't throw. Pinned in Task 6.

---

### Task 1: Providers accept a tool choice

**Files:**
- Modify: `server/src/providers/types.ts` (`ChatRequest`)
- Modify: `server/src/openrouter.ts` (`toolFields`, `OpenRouterClient.streamChat` options, `streamChat` implementation)
- Modify: `server/src/providers/openaiCompat.ts` (stream body)
- Test: `server/test/openrouter.test.ts`, and the openai-compatible provider test that records request bodies (`server/test/providers.test.ts`)

**Interfaces:**
- Produces: `ChatRequest.toolChoice?: 'auto' | 'required'` (default `'auto'` when tools are sent). OpenRouter's `streamChat` options gain the same field. Ollama ignores it (it has no `tool_choice`).

- [ ] **Step 1: Write the failing tests**
  - `openrouter.test.ts`, next to the existing `tool_choice` test (line ~269): `it('sends tool_choice required when asked')`: body of a `streamChat` with tools and `toolChoice: 'required'` has `tool_choice === 'required'`; without `toolChoice` it is still `'auto'`.
  - providers test for the OpenAI-compatible client (LM Studio / openai flavor against `test/fakeLocalServer.ts`, reading `fake.requests`): `it('passes toolChoice to OpenAI-compatible servers')`: the chat request body has `tool_choice: 'required'`.
- [ ] **Step 2: Run them to see them fail**: `npx vitest run server/test/openrouter.test.ts server/test/providers.test.ts`. Expected: the two new tests FAIL (`'auto'` received).
- [ ] **Step 3: Implement.** Add the field to `ChatRequest`; thread it through `toolFields(mode, plugins, functions, toolChoice = 'auto')` and the OpenAI-compatible body. The OpenRouter wrapper in `server/src/providers/index.ts` already spreads the request, so it needs no change; confirm it.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(providers): let a request require a tool call`

### Task 2: Decision prompt and text fallback in the engine

**Files:**
- Modify: `server/src/discussion/engine.ts`
- Test: `server/test/discussionEngine.test.ts`

**Interfaces:**
- Produces:
  - `buildDecisionPrompt(topic: string, participants: DiscussionParticipant[], messages: Message[], speaker: DiscussionParticipant, reply: string): ChatMessage[]`: `buildDiscussionPrompt(...)` for the moderator, then `{ role: 'assistant', content: reply || '(You said nothing.)' }`, then `{ role: 'user', content: DECISION_PROMPT }`.
  - `DECISION_PROMPT = 'Who should speak next? Call pass_to with their name, or end_discussion if the discussion is finished. If you cannot call a tool, reply with only their name, or END.'`
  - `readTextDecision(participants: DiscussionParticipant[], text: string): { handoffTo: string } | { end: string } | null`: trimmed text (surrounding `*`, `_`, quotes and a final `.` stripped) that `matchParticipant` matches to a non-moderator gives `{ handoffTo: id }`; `END` (any case) gives `{ end: 'The moderator ended the discussion.' }`; anything else `null`.

- [ ] **Step 1: Write the failing tests**
  - `describe('buildDecisionPrompt')`, `it('appends the reply and the decision question to the moderator prompt')`: for `moderated` with messages `[say(mod, 'Welcome.', 'egg'), say(egg, 'The egg.')]` and reply `'Thanks, Egg.'`, the result equals `buildDiscussionPrompt(topic, moderated, messages, mod)` followed by `{ role: 'assistant', content: 'Thanks, Egg.' }` and `{ role: 'user', content: DECISION_PROMPT }`; with reply `''` the assistant content is `'(You said nothing.)'`.
  - `describe('readTextDecision')`:
    - `it('reads a name as a handoff')`: `'Chicken-Defender'`, `'**chicken-defender**.'` → `{ handoffTo: 'chicken' }`.
    - `it('reads END as an end')`: `'END'`, `'end'` → `{ end: 'The moderator ended the discussion.' }`.
    - `it('rejects anything else')`: `'Moderator'`, `'Chicken-Defender should go'`, `''` → `null`.
- [ ] **Step 2: Run** `npx vitest run server/test/discussionEngine.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement** both functions and the constant in `engine.ts`, exported.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(discussion): decision prompt and plain-text decision fallback`

### Task 3: Moderator follow-up decision in a turn

**Files:**
- Modify: `server/src/discussion/turn.ts` (`streamTurn` → `run`)
- Test: `server/test/discussionTurn.test.ts` (extend `scripted` to record `toolChoice`)

**Interfaces:**
- Consumes: `buildDecisionPrompt`, `readTextDecision` (Task 2); `ChatRequest.toolChoice` (Task 1); existing `moderatorTools`, `readToolCall`, `recordModeratorTurn`, `settle`.
- Produces: no new exports. The `status` SSE event is reused with `{ message: 'Deciding who speaks next…' }` before the follow-up.

- [ ] **Step 1: Write the failing tests** (all with `withModerator()`; `scripted` records `toolChoice` per call):
  - `it('asks a moderator that skipped the tool to decide, and ends when it says so')`: turns `[{ text: ['That was great. Tabs wins.'] }, { tool: { name: 'end_discussion', arguments: '{"reason":"Done"}' } }]`. One turn: `s.calls.length === 2`, `s.calls[1].toolChoice === 'required'`, `s.calls[1].messages.at(-1).content === DECISION_PROMPT`; `done.state` is `{ status: 'ended', endReason: 'moderator', endNote: 'Done' }`; saved content `'That was great. Tabs wins.'`; events include a `status` with `'Deciding who speaks next…'`.
  - `it('adds the follow-up cost to the moderator message')`: same script; `done.message.cost === 0.004`, `promptTokens === 2`, `completionTokens === 4`.
  - `it('reads a plain-text name from the follow-up as a handoff')`: second turn `{ text: ['Chicken-Defender'] }`; `done.message.handoffTo` is the chicken participant's id, and the next turn's speaker is chicken.
  - `it('makes no follow-up when the moderator called a tool')`: first turn already has a valid `pass_to`: `s.calls.length === 1`.
  - `it('counts a miss when the follow-up decides nothing either')` (Review Focus 1): two moderator turns whose follow-ups both answer `{ text: ['Hmm.'] }`. Both turns complete with status 200 and `done` events; after the second, `state.moderatorNoteAfter` is set; no `error` event.
  - `it('makes no follow-up for a stopped turn')`: abort the first moderator turn mid-stream (existing `hold` pattern) → `s.calls.length === 1`.
- [ ] **Step 2: Run** `npx vitest run server/test/discussionTurn.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** After the stream loop in `run`, when `speaker.isModerator` and `readToolCall` gives `null` (no call, or invalid) and the abort signal hasn't fired: send the status event, run `provider.streamChat({ model, messages: buildDecisionPrompt(topic, participants, history, speaker, cleanedText), tools, toolChoice: 'required', signal })`, take its first `tool_call` (through `readToolCall`), else `readTextDecision` on its text. Add its usage to `usage` before `save` (sum `promptTokens`, `completionTokens`, `cost`, treating null as 0 but keeping null when both are null). A failure of the follow-up itself counts as a miss, not a turn error. Then save, `recordModeratorTurn` and `settle` as today with the resulting decision.
- [ ] **Step 4: Run** `npx vitest run server/test/discussion*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(discussion): make the moderator decide when it skips the tool`

### Task 4: "Let the moderator decide" turn limit (server and shared)

**Files:**
- Modify: `shared/types.ts` (`NewDiscussion.moderatorDecides?: boolean`, `DiscussionState.moderatorDecides: boolean`)
- Modify: `shared/discussion.ts` (`validateNewDiscussion`)
- Modify: `server/src/db.ts` (migration: `ALTER TABLE discussions ADD COLUMN moderator_decides INTEGER NOT NULL DEFAULT 0`, same pattern as `moderator_misses`)
- Modify: `server/src/discussion/store.ts` (`createDiscussion`, `discussionState`, new `clearModeratorDecides(db, chatId): void`)
- Modify: `server/src/routes/discussions.ts` (`/more-turns`)
- Modify: `web/src/lib/discussion.ts` (`turnLabel`)
- Test: `shared/discussion.test.ts`, `server/test/discussionStore.test.ts`, `server/test/discussionTurn.test.ts` (more-turns), `web/src/lib/discussion.test.ts`; update `DiscussionState` fixtures (e.g. `web/src/lib/discussionLoop.test.ts` `active`) with `moderatorDecides: false`.

**Interfaces:**
- Produces: `DiscussionState.moderatorDecides`; `NewDiscussion.moderatorDecides`; `turnLabel(s)` returns `` `Turn ${turnsTaken}` `` when `moderatorDecides`, else `` `Turn ${turnsTaken} of ${turnLimit}` ``.

- [ ] **Step 1: Write the failing tests**
  - shared: `it('only lets a discussion with a moderator skip the turn limit')`: `moderatorDecides: true` without a moderator → `'Only a discussion with a moderator can let the moderator decide when it ends.'`; with one → `null`.
  - store: `it('stores a moderator-decides discussion with the 100-turn cap')`: created with `moderatorDecides: true, turnLimit: 5` → state `{ turnLimit: 100, moderatorDecides: true }`. A normal one → `moderatorDecides: false`.
  - route: `it('refuses +2 turns while a moderator-decides discussion runs')` → 400 `'This discussion has no turn limit.'`.
  - route (Review Focus 4): `it('turns an ended moderator-decides discussion into a limited one on +2 turns')`: end it via stop after 3 turns; POST more-turns → state `{ status: 'active', turnLimit: 5, moderatorDecides: false }`; a second +2 after it ends again works too.
  - web: `turnLabel` with and without `moderatorDecides`.
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement.** `createDiscussion` stores `turn_limit = MAX_TURN_LIMIT` and `moderator_decides = 1` when the flag is set. `/more-turns`: active + flag → `HttpError(400, ...)`; ended + flag → `clearModeratorDecides` in the same transaction as the existing limit/status update.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(discussion): let the moderator decide when a discussion ends`

### Task 5: Loop holds for reveal, wait-for-me and typing

**Files:**
- Modify: `web/src/lib/discussionLoop.ts`
- Test: `web/src/lib/discussionLoop.test.ts`

**Interfaces:**
- Produces:
  - `LoopState` gains `revealing: boolean`, `waitForMe: boolean`, `awaitingNext: boolean`.
  - `initialLoop(state, justCreated, waitForMe = false)`.
  - Events: `turnDone` becomes `{ type: 'turnDone'; state: DiscussionState; visible: boolean; reveal: boolean }` (`visible`: the saved reply has text; `reveal`: the view will reveal it). New: `{ type: 'revealDone' }`, `{ type: 'next' }`, `{ type: 'setWaitForMe'; on: boolean }`.
  - `nextAction(s: LoopState, drafting = false): 'turn' | 'sendHost' | 'idle'`.

Rules: `turnDone` sets `revealing = visible && reveal` and `awaitingNext = visible && waitForMe`. `revealDone` clears `revealing`. `next` clears `awaitingNext` and, if paused, does not resume. `hostSent` clears `awaitingNext`. `stopped` clears `revealing` and `awaitingNext`. `nextAction`: streaming → idle; queued → sendHost; mode not running → idle; revealing, awaitingNext or drafting → idle; else turn.

- [ ] **Step 1: Write the failing tests**
  - `it('holds the next turn until the reveal is done')`
  - `it('waits for Next after a visible reply in wait-for-me mode')`, plus `it('lets a silent moderator turn flow through in wait-for-me mode')` (`visible: false` → `turn`).
  - `it('counts a sent host message as Next')`.
  - `it('holds while the host is drafting and continues when the box is cleared')` (Review Focus 3): `nextAction(s, true) === 'idle'`, `nextAction(s, false) === 'turn'`; a queued host message is still sent while drafting (`'sendHost'`).
  - `it('clears every hold when stopped')` (Review Focus 2).
  - Update existing `turnDone` events to the new shape and `initialLoop` equality to include the new fields.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/discussionLoop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the rules above.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(discussion): loop holds for reveal, wait-for-me and typing`

### Task 6: Reveal helpers and discussion preferences

**Files:**
- Create: `web/src/lib/reveal.ts`, `web/src/lib/reveal.test.ts`
- Create: `web/src/lib/discussionPrefs.ts`, `web/src/lib/discussionPrefs.test.ts`

**Interfaces:**
- Produces:
  - `REVEAL_WPS = 6`, `REVEAL_MAX_MS = 10_000`, `REVEAL_BEAT_MS = 1_000`.
  - `countWords(text: string): number`; `wordsPrefix(text: string, n: number): string` (the text up to and including the n-th word, keeping its original whitespace and markdown; whole text when `n >= countWords`).
  - `revealRate(totalWords: number): number` = `Math.max(REVEAL_WPS, totalWords / (REVEAL_MAX_MS / 1000))` words per second.
  - `type RevealMode = 'natural' | 'instant'`; `interface DiscussionPrefs { reveal: RevealMode; waitForMe: boolean }`; `DEFAULT_DISCUSSION_PREFS = { reveal: 'natural', waitForMe: false }`; `loadDiscussionPrefs(): DiscussionPrefs`; `saveDiscussionPrefs(p: DiscussionPrefs): void`; storage key `'openchat.discussionPrefs'` (JSON).

- [ ] **Step 1: Write the failing tests**
  - reveal: `revealRate(30) === 6`, `revealRate(120) === 12`; `countWords('Hi  there\nfriend') === 3`; `wordsPrefix('Hi **there** friend', 2) === 'Hi **there**'`; `wordsPrefix('a b', 5) === 'a b'`.
  - prefs: defaults when nothing is saved; round trip; invalid JSON or unknown values → defaults; (Review Focus 5) with `localStorage.getItem`/`setItem` throwing (stub `globalThis.localStorage`), `loadDiscussionPrefs()` returns the defaults and `saveDiscussionPrefs` does not throw. Follow the storage stubbing style of `web/src/lib/chatPrefs.test.ts`.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/reveal.test.ts web/src/lib/discussionPrefs.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(discussion): reveal helpers and pacing preferences`

### Task 7: Discussion page: controls, options menu, reveal and typing hold

**Files:**
- Create: `web/src/components/discussion/DiscussionOptions.tsx` (the two option groups; used in Task 8 too)
- Create: `web/src/components/discussion/useReveal.ts`
- Modify: `web/src/components/discussion/DiscussionView.tsx`, `DiscussionTranscript.tsx`
- Modify: the discussion styles in `web/src/styles/` (wherever `.discussion-tools` / `.composer-bar` live)

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `DiscussionOptions({ prefs, onChange }: { prefs: DiscussionPrefs; onChange(p: DiscussionPrefs): void })`: two radio groups, "Show replies: Naturally / Instantly" and "After each reply: Keep going / Wait for me".
  - `useReveal(text: string, enabled: boolean, streaming: boolean): { shown: string; done: boolean; showAll(): void }`: with `enabled` false, `shown = text`, `done = !streaming`. Otherwise it advances a word count on a timer at `revealRate(countWords(text))` words per second, never past the words received; `done` once the stream has ended and every word is shown.

Behavior to build (manual checks below, since this repo has no component tests):
- Pause/Resume, Stop (danger) and, when `loop.awaitingNext`, **Next** are buttons in the composer bar while the discussion is active; plus an options icon button opening a popover with `DiscussionOptions` (same popover pattern as `ParticipantsPopover`). Remove Pause/Resume/Stop from the header; the header keeps the turn label, participants, Summarize, Print, and **+2 turns** (hidden while active when `state.moderatorDecides`).
- `LiveTurn` (in `DiscussionTranscript.tsx`) gains `done?: boolean` and `message?: Message` (the saved reply while it is still being revealed).
- Prefs load once with `loadDiscussionPrefs()` and `initialLoop` gets `prefs.waitForMe`; a change saves and dispatches `setWaitForMe`. Pause during a reveal lets the reveal finish and starts nothing new (the loop already holds on `mode`).
- Live turn: the transcript renders the live text through `useReveal(live.text, prefs.reveal === 'natural', !live.done)`; clicking it calls `showAll`. In natural mode `onDone` keeps the live turn (with the saved message's content and `done: true`) instead of appending; when `useReveal` reports done, wait `REVEAL_BEAT_MS`, then append the message, clear `live` and dispatch `revealDone`. Dispatch `turnDone` with `visible = !!message.content.trim()`, `reveal = natural && visible`.
- Stop during a reveal appends the saved message at once and clears `live` (Review Focus 2).
- Live status line shows `live.status` whenever it is set (so "Deciding who speaks next…" shows after text), else "writing…".
- `nextAction(loop, draft.trim() !== '')`. Composer status text: "Waiting for you to send your message." when the hold is what's stopping a running loop; otherwise as today.
- Send button label "Send after this turn" while streaming, as today.

- [ ] **Step 1: Implement** `useReveal`, `DiscussionOptions` and the view/transcript changes.
- [ ] **Step 2: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Check in the app** with `preview_start` (`openchat-verify` config) and the fake Ollama (`npm run fake-local -- --flavor ollama --port 11434`, whose replies are short): start a discussion and confirm (a) replies appear word by word and the next turn starts about a second after each finishes, (b) typing holds the next turn and clearing the box releases it, (c) Wait for me shows Next after each reply, (d) Stop during a reveal shows the full reply and nothing more runs, (e) Instantly behaves as before, (f) light and dark mode both look right. Take a screenshot of the running discussion's control bar.
- [ ] **Step 4: Commit** `feat(discussion): paced replies, typing hold and clearer controls`

### Task 8: Setup form: turn-limit choice and Options section

**Files:**
- Modify: `web/src/components/discussion/DiscussionSetup.tsx`

**Interfaces:**
- Consumes: `DiscussionOptions`, `loadDiscussionPrefs`, `saveDiscussionPrefs` (Tasks 6–7); `NewDiscussion.moderatorDecides` (Task 4).

Behavior:
- With a moderator selected, the turn-limit area offers **Let the moderator decide** (default) or **Stop after N turns** (the existing number field). Without a moderator, only the number field, as today. Start sends `moderatorDecides: true` and `turnLimit: MAX_TURN_LIMIT` for the first choice.
- A collapsed `<details>` "Options" section at the bottom shows `DiscussionOptions` bound to the saved prefs; changes save immediately.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Check in the app:** with a moderator ticked, the choice appears and defaults to Let the moderator decide; starting shows "Turn 1" with no "of"; unticking the moderator brings back the plain number field; options chosen here are what the running discussion uses.
- [ ] **Step 4: Commit** `feat(discussion): moderator-decides limit and options in setup`
