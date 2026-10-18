# Discussion tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discussion tab where 2–6 named participants (model + private instructions) take turns, optionally ordered by a moderator model that uses tools, while the owner watches, steps in, summarizes and prints.

**Architecture:** A discussion is a chat row with `kind = 'discussion'`, plus a `discussions` row (topic, turn limit, status, summary) and `discussion_participants` rows. Turns are ordinary `messages` rows with a `participant_id` (null for host lines) and a `handoff_to` (moderator turns). The **client drives the loop**: it asks `POST /api/discussions/:id/turn` for one turn at a time over SSE. Pause means not asking again, and closing the page stops it. The server decides who speaks, builds that speaker's prompt and streams one model call. Speaker choice, prompt building and reply cleaning are pure functions in `server/src/discussion/engine.ts`. The print report is server-rendered with `react-dom/server` and the existing `react-markdown`, so no new dependencies are needed.

**Tech Stack:** Hono, better-sqlite3, React 19 + Vite, Vitest, OpenRouter (OpenAI-style function tools).

**Spec:** `docs/superpowers/specs/2026-10-18-discussion-tab-design.md`

## Global Constraints

- Every model call goes through OpenRouter (`deps.openrouter`).
- No new npm dependencies. In particular, no Chromium/Puppeteer.
- Each model sees only its own instructions, plus the other participants' names.
- Limits (in `shared/discussion.ts`):
  - participants: 2 to 6
  - participant name: 1–40 characters, unique case-insensitively, and not "Host"
  - topic: 1–500 characters
  - turn limit: 1–100, default 10
  - instructions: at most `MAX_INSTRUCTIONS` (20 000)
  - at most one moderator, and at least one participant who isn't the moderator
- The moderator's model must support tools (`modelSupportsTools`).
- `checkSpend(db)` runs before every paid call. A limit never cuts a call off mid-stream.
- Every model call is logged with `recordUsage` (`threadKind: 'discussion'`).
- All model text in the report is untrusted. The report has no raw-HTML markdown and a CSP of `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:`.
- Keep each file's existing line endings (LF).
- Commit style `feat(server): …` / `feat(web): …` / `test(server): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `claude/discussion-tab`.
- Never touch the user's server on port 3000. Verify with `OPENCHAT_PORT` set to another port.
- Paid verification needs the user's OK first, with an estimated cost.
- Done means:
  - `npx vitest run` and `npx tsc --noEmit` pass
  - the UI is checked in the browser
  - everything is committed

## Review Focus

1. **The moderator names someone loosely** ("egg-defender", " Egg-Defender ", "Moderator", or an unknown name). Matching is trimmed and case-insensitive. The moderator itself or an unknown name falls back to rotation. The discussion never stalls. *(Task 3: `matchParticipant` / `nextSpeaker` tests.)*
2. **A non-moderator returns an empty reply.** It still counts as a turn. Otherwise the turn limit could never be reached and the loop would spend forever. Only a moderator turn with no text and a valid handoff is free. *(Task 3: `turnsTaken` test.)*
3. **The stream fails mid-turn** (provider error, network). The partial is saved as `stopped`, the client loop **pauses**, and it doesn't retry by itself. *(Task 5: server test; Task 8: reducer test.)*
4. **The host posts while a turn is streaming, or after the discussion ended.** The server refuses with 409 while a turn is streaming (the client queues). On an ended discussion it saves the message and the discussion stays ended, with no turn. *(Task 5 tests; Task 8 reducer test.)*
5. **Model text containing `<script>` or `javascript:` links reaches the report.** It is rendered inert: escaped text, link removed. *(Task 6: report test.)*

---

## File map

| File | Responsibility |
|---|---|
| `shared/types.ts` (modify) | `ThreadKind` gains `'discussion'`; `Message` gains `participantId`, `handoffTo`; discussion API types |
| `shared/discussion.ts` (create) | Limits, `validateNewDiscussion`, participant colors. Shared by server and web |
| `server/src/db.ts` (modify) | New tables, `messages` columns, migration |
| `server/src/messages.ts` (modify) | Read/write `participant_id`, `handoff_to` |
| `server/src/openrouter.ts` (modify) | Custom function tools in `streamChat`, `tool_call` stream event |
| `server/src/discussion/engine.ts` (create) | Pure: speaker choice, turn counting, name matching, reply cleaning, prompts, moderator tools |
| `server/src/discussion/store.ts` (create) | DB reads/writes for discussions and participants; `getDiscussionDetail` |
| `server/src/discussion/turn.ts` (create) | `streamTurn`: one SSE turn |
| `server/src/discussion/summary.ts` (create) | `summarizeDiscussion` |
| `server/src/discussion/report.tsx` (create) | `renderReport` → HTML string |
| `server/src/routes/discussions.ts` (create) | `/api/discussions` routes |
| `server/src/app.ts` (modify) | Mount the routes |
| `server/src/routes/chats.ts`, `routes/stats.ts`, `dataStore.ts`, `exportData.ts` (modify) | List, stats, Data tab, export cover discussions |
| `web/src/lib/route.ts`, `components/Sidebar.tsx`, `App.tsx` (modify) | Discussions mode and route |
| `web/src/api.ts` (modify) | Discussion endpoints, `streamDiscussionTurn` |
| `web/src/lib/discussionLoop.ts` (create) | Pure client loop state machine |
| `web/src/lib/discussion.ts` (create) | `cheapestModel`, `turnLabel` |
| `web/src/pages/DiscussionPage.tsx` (create) | Setup or view, by route |
| `web/src/components/discussion/*.tsx` (create) | Setup form, header, participants popover, transcript, composer, summary card |
| `web/src/pages/settings/DataTab.tsx` (modify) | Discussions storage line and delete |

---

### Task 1: Types, schema and messages

**Files:**
- Modify: `shared/types.ts`, `server/src/db.ts`, `server/src/messages.ts`
- Create: `shared/discussion.ts`, `shared/discussion.test.ts`
- Test: `server/test/db.test.ts`, `server/test/discussionStore.test.ts` (messages part only here)

**Interfaces:**
- Produces (in `shared/types.ts`):
  ```ts
  export type ThreadKind = 'chat' | 'image' | 'video' | 'discussion';
  // Message gains:
  /** Discussions: who said it; null for host lines and in other threads. */
  participantId: string | null;
  /** Discussions: the participant a moderator turn handed the floor to; null otherwise. */
  handoffTo: string | null;

  export interface DiscussionParticipant { id: string; position: number; name: string; modelId: string; instructions: string; isModerator: boolean }
  export type DiscussionStatus = 'active' | 'ended';
  export type DiscussionEndReason = 'limit' | 'stopped' | 'moderator';
  export interface DiscussionState {
    status: DiscussionStatus; endReason: DiscussionEndReason | null;
    /** The moderator's end_discussion reason. */ endNote: string | null;
    turnLimit: number; turnsTaken: number;
  }
  export interface DiscussionSummary { text: string; modelId: string; cost: number | null; createdAt: number }
  export interface DiscussionDetail {
    chat: { id: string; title: string; updatedAt: number; totalCost: number };
    topic: string;
    participants: (DiscussionParticipant & { turns: number; cost: number })[];
    messages: Message[];
    state: DiscussionState;
    summary: DiscussionSummary | null;
  }
  export interface NewDiscussion {
    topic: string; turnLimit: number;
    participants: { name: string; modelId: string; instructions: string; isModerator: boolean }[];
  }
  // SSE from POST /api/discussions/:id/turn
  export interface DiscussionTurnStart { messageId: string; participantId: string }
  export interface DiscussionTurnDone { message: Message; state: DiscussionState }
  export interface DiscussionTurnError { message: string; partial: Message | null; state: DiscussionState }
  ```
- Produces (in `shared/discussion.ts`): `MIN_PARTICIPANTS = 2`, `MAX_PARTICIPANTS = 6`, `NAME_MAX = 40`, `TOPIC_MAX = 500`, `DEFAULT_TURN_LIMIT = 10`, `MAX_TURN_LIMIT = 100`, `HOST_NAME = 'Host'`, `validateNewDiscussion(d: NewDiscussion, maxInstructions: number): string | null` (first error message, or null), `PARTICIPANT_COLORS: { bg: string; fg: string }[]` (6 entries: purple, coral, teal, pink, amber, blue, using the 50/800 stops from the brainstorm mockup), `participantColor(position: number)`.
- Produces (in `messages.ts`): `NewMessage` accepts optional `participantId`, `handoffTo`.

- [ ] **Step 1: Write failing tests**

`shared/discussion.test.ts`, `describe('validateNewDiscussion')`. Each case starts from a valid two-participant draft:
- valid → `null`
- 1 participant → `'A discussion needs 2 to 6 participants.'`
- 7 participants → same message
- names `'Egg'` and `' egg '` → `'Each participant needs a different name.'`
- name `'host'` → `'"Host" is reserved for you. Pick another name.'`
- empty name → `'Every participant needs a name.'`
- 41-character name → `'Names can be at most 40 characters.'`
- empty `modelId` → `'Pick a model for every participant.'`
- blank topic → `'Enter a topic.'`
- 501-character topic → `'The topic can be at most 500 characters.'`
- `turnLimit` 0, 101 or 2.5 → `'The turn limit must be a whole number from 1 to 100.'`
- two moderators → `'Only one participant can be the moderator.'`
- moderator plus one other → `null`
- instructions longer than max → `'Instructions can be at most 20,000 characters.'` (use `maxInstructions.toLocaleString('en-US')`)

`server/test/db.test.ts`:
- `it('creates discussion tables and message columns')`: `PRAGMA table_info` includes `discussions(chat_id, topic, turn_limit, status, end_reason, end_note, summary, summary_model_id, summary_cost, summary_at)`, `discussion_participants(id, chat_id, position, name, model_id, instructions, is_moderator)`, and `messages.participant_id`, `messages.handoff_to`.
- `it('adds participant columns to an old messages table')`: build the old `messages` shape in a temp file, `openDb` it, and the columns exist.
- `it('deleting a discussion chat removes its discussion and participants')`.

`server/test/discussionStore.test.ts`, `it('insertMessage round-trips participantId and handoffTo')`: both null by default, set values come back.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run shared/discussion.test.ts server/test/db.test.ts server/test/discussionStore.test.ts`
Expected: FAIL (module/columns missing).

- [ ] **Step 3: Implement**

- Add the types and `shared/discussion.ts`.
- Add to `SCHEMA` in `db.ts`:
  - `discussions`:
    - `chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE`
    - `status TEXT NOT NULL CHECK (status IN ('active','ended'))`
    - `end_reason TEXT CHECK (end_reason IN ('limit','stopped','moderator'))`
    - the rest of the columns as named in the test
  - `discussion_participants`: `chat_id` references `chats(id) ON DELETE CASCADE`, plus an index on `(chat_id, position)`.
- In `migrate()`, add `messages.participant_id TEXT` and `messages.handoff_to TEXT`, as existing columns are added.
- In `messages.ts`, map the two columns in `MessageRow`/`toMessage`/`insertMessage`.
- Every other place that builds a `Message` literal (grep `webSearches:` in `server/src` and `web/src`) gets `participantId: null, handoffTo: null` so `tsc` passes.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**: `feat(server): discussion schema, types and validation`

---

### Task 2: Function tools in `streamChat`

**Files:**
- Modify: `server/src/openrouter.ts`
- Test: `server/test/openrouter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FunctionTool { name: string; description: string; parameters: object /* JSON Schema */ }
  // StreamEvent gains:
  | { type: 'tool_call'; name: string; arguments: string /* raw JSON text */ }
  // streamChat options gain: tools?: FunctionTool[]
  ```

- [ ] **Step 1: Write failing tests**
- `it('sends function tools alongside web search')`: the request body has `tools` with `{ type: 'function', function: { name, description, parameters } }` entries **and** the `openrouter:web_search` entry when both are given, plus `tool_choice: 'auto'`. Without `tools`, the body is unchanged from today (assert no `tool_choice`).
- `it('assembles streamed tool call arguments')`: use `streamOf` to send three chunks:
  - `delta.tool_calls[0]` with `function.name: 'pass_to'` and `arguments: '{"na'`
  - then `arguments: 'me":"Egg"}'`
  - then a chunk with `finish_reason: 'tool_calls'`, then `[DONE]`
  The collected events include exactly one `{ type: 'tool_call', name: 'pass_to', arguments: '{"name":"Egg"}' }`, emitted after any `delta` events.
- `it('emits tool calls when the stream ends without [DONE]')`.

- [ ] **Step 2: Run them and see them fail** (`npx vitest run server/test/openrouter.test.ts`)

- [ ] **Step 3: Implement**

- Accumulate `delta.tool_calls` by `index` (the name arrives once; arguments concatenate).
- Yield the accumulated calls in index order when `[DONE]` arrives or the body ends.
- Merge function tools with `searchFields(...).tools` instead of overwriting them.

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**: `feat(server): custom function tools in streamChat`

---

### Task 3: Discussion engine (pure)

**Files:**
- Create: `server/src/discussion/engine.ts`
- Test: `server/test/discussionEngine.test.ts`

**Interfaces:**
- Consumes: `DiscussionParticipant`, `Message` (Task 1), `FunctionTool` (Task 2), `ChatMessage`/`withCacheMarkers` (`prompt.ts`).
- Produces:
  ```ts
  /** The participant called `name`: trimmed, case-insensitive; undefined when none. */
  export function matchParticipant(participants: DiscussionParticipant[], name: string): DiscussionParticipant | undefined;
  /** Spoken turns: every participant message except a moderator's with no text. */
  export function turnsTaken(participants: DiscussionParticipant[], messages: Message[]): number;
  /** Who speaks next, given the transcript so far (oldest first). */
  export function nextSpeaker(participants: DiscussionParticipant[], messages: Message[]): DiscussionParticipant;
  /** Drops a leading own-name label and anything from the first line that labels someone else. */
  export function cleanReply(text: string, speaker: string, others: string[]): string;
  export function moderatorTools(participants: DiscussionParticipant[]): FunctionTool[];
  /** Reads a moderator's tool call: a handoff (participant id) or an end, or null when neither is valid. */
  export function readToolCall(participants: DiscussionParticipant[], call: { name: string; arguments: string }):
    { handoffTo: string } | { end: string } | null;
  export function buildDiscussionPrompt(topic: string, participants: DiscussionParticipant[], messages: Message[], speaker: DiscussionParticipant): ChatMessage[];
  ```

**Rules the tests pin:**
- **Rotation (no moderator):**
  - The first turn goes to position 0.
  - After that, the next position after the last message that has a `participantId`, wrapping around.
  - Host messages don't move the rotation.
- **Moderated:**
  - When the last participant message is the moderator's and its `handoffTo` is a valid non-moderator, that participant speaks.
  - When the moderator's message has no valid `handoffTo`, the rotation continues among non-moderators: the next after the last non-moderator who spoke (the first non-moderator if none has).
  - In every other case (no messages yet, the last speaker wasn't the moderator, or host messages since), the moderator speaks.
- **`readToolCall`:**
  - `pass_to` with a name that matches a non-moderator → `{ handoffTo: id }`.
  - The moderator's own name, an unknown name, or malformed JSON → `null`.
  - `end_discussion` → `{ end: reason.trim() || 'The moderator ended the discussion.' }`.
- **`moderatorTools`:**
  - `pass_to`: `{ name: { type: 'string', enum: [non-moderator names] } }`, required `name`, description `'Give the floor to the next speaker.'`.
  - `end_discussion`: `{ reason: { type: 'string' } }`, required `reason`, description `'End the discussion.'`.
- **`cleanReply`:**
  - Strip leading whitespace, then one of `**Name:**`, `**Name**:` or `Name:` (case-insensitive) for the speaker's own name.
  - Cut at the first `\n` that is followed by optional `**`, then another name or `Host`, then `:`.
  - Trim the result.
- **Prompt:**
  - **System message** (one string, paragraphs joined by `\n\n`, empty instructions skipped):
    1. `You are ${name}. You're in a discussion with ${others} about: "${topic}". The person watching is the Host, who may step in.`
       `others` is joined as `A`, `A and B`, or `A, B and C`.
    2. The speaker's own instructions.
    3. Moderator only: `You are the moderator. After you speak, call pass_to with the name of who should speak next, or call end_discussion if the discussion is finished. You may call pass_to without saying anything.`
    4. `Write only your own reply. Don't write lines for anyone else, and don't start with your name.`
  - **History:**
    - The speaker's own messages become `assistant` messages. A moderator's handoff is appended as `(You passed the floor to ${name}.)`, or forms the whole content when the moderator said nothing.
    - Everything else since its last turn merges into one `user` message, parts joined by `\n\n`:
      - `**${name}:** ${content}` for participants
      - `**Host:** ${content}` for host lines
      - `_${moderatorName} passed the floor to ${name}._` for others' silent handoffs
  - **Closing cue:**
    - The final `user` message ends with `It's your turn, ${speaker.name}.`, added as its own paragraph.
    - When there are no messages yet, it is the only user message: `The discussion is starting. It's your turn, ${name}.`
    - If the first non-system message would be `assistant`, a `user` message `The discussion is starting.` goes before it.
  - The result goes through `withCacheMarkers(speaker.modelId, …)`.

- [ ] **Step 1: Write failing tests.** One `it` per rule above, with three participants: Egg-Defender(0), Chicken-Defender(1), Moderator(2, moderator). Include the Review Focus cases:
  - `it('matches names trimmed and case-insensitively')`
  - `it('falls back to rotation when the moderator hands the floor to itself or an unknown name')`
  - `it('counts an empty non-moderator reply as a turn but not a silent moderator handoff')`: messages are Egg `''`, Moderator `''` with a handoff → `turnsTaken === 1`
  - `it('never sees other participants instructions')`: Chicken's instructions string is absent from Egg's prompt JSON
  - `it('keeps user/assistant alternation')`: no two adjacent messages share a role after the system message
- [ ] **Step 2: Run them and see them fail** (`npx vitest run server/test/discussionEngine.test.ts`)
- [ ] **Step 3: Implement `engine.ts`** to the signatures and rules.
- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**: `feat(server): discussion engine (turn order, prompts, reply cleaning)`

---

### Task 4: Store and create/read routes

**Files:**
- Create: `server/src/discussion/store.ts`, `server/src/routes/discussions.ts`
- Modify: `server/src/app.ts` (mount at `/api/discussions`), `server/src/routes/chats.ts`
- Test: `server/test/discussionStore.test.ts`, `server/test/discussionRoutes.test.ts`

**Interfaces:**
- Consumes: `validateNewDiscussion` (Task 1), `turnsTaken` (Task 3), `modelSupportsTools` (`library.ts`), `createChat`/`renameChat` and the usage-based chat cost query (`chats.ts:105`) in `chats.ts`.
- Produces:
  ```ts
  export interface DiscussionRow { chatId: string; topic: string; turnLimit: number; status: DiscussionStatus; endReason: DiscussionEndReason | null; endNote: string | null }
  export function createDiscussion(db: DB, d: NewDiscussion): DiscussionDetail; // throws HttpError(400) with validateNewDiscussion's message
  export function getDiscussionRow(db: DB, chatId: string): DiscussionRow;    // HttpError(404, 'Discussion not found.')
  export function getParticipants(db: DB, chatId: string): DiscussionParticipant[]; // by position
  export function discussionState(db: DB, chatId: string): DiscussionState;
  export function setStatus(db: DB, chatId: string, status: DiscussionStatus, endReason: DiscussionEndReason | null, endNote?: string | null): void;
  export function setTurnLimit(db: DB, chatId: string, turnLimit: number): void;
  export function saveSummary(db: DB, chatId: string, s: DiscussionSummary): void;
  export function getDiscussionDetail(db: DB, chatId: string): DiscussionDetail;
  ```
- Routes: `POST /api/discussions` (body `NewDiscussion`, 201 → `DiscussionDetail`), `GET /api/discussions/:id` → `DiscussionDetail`.

- [ ] **Step 1: Write failing tests**
- **Create:** `it('creates a discussion with trimmed participants in order')`:
  - the chat's `kind` is `'discussion'`
  - its title is the topic (trimmed, at most 200 characters)
  - the state is `{ status: 'active', endReason: null, endNote: null, turnLimit: 10, turnsTaken: 0 }`
  - the participants have positions 0..n-1
- **Validation:** `it('rejects an invalid discussion with the validation message')` → 400 `{ error: 'A discussion needs 2 to 6 participants.' }`.
- **Moderator model:** `it('rejects a moderator whose model cannot use tools')` → 400 `{ error: 'The moderator needs a model that can use tools. Pick another model for it.' }`. Seed `models` with `supports_tools = 0`.
- **Per-participant stats:** `it('reports turns and cost per participant')`:
  - insert participant messages with costs `0.01` and `0.02` for Egg, plus one silent moderator handoff costing `0.001`
  - Egg `{ turns: 2, cost: 0.03 }`; Moderator `{ turns: 0, cost: 0.001 }`
- **Listing:** `it('lists discussions under kind=discussion and not under chats')`:
  - `GET /api/chats?kind=discussion` contains it
  - `GET /api/chats` does not
- **Creating through chats:** `it('refuses to create a discussion through POST /api/chats')` → 400 `{ error: 'Create discussions from the Discussion tab.' }`.

- [ ] **Step 2: Run them and see them fail**

- [ ] **Step 3: Implement**
- Create everything in one `db.transaction`.
- `KINDS` in `routes/chats.ts` gains `'discussion'` for listing. `POST /` refuses it.
- `getChatDetail` isn't used for discussions.
- Per-participant `cost` sums `messages.cost` grouped by `participant_id`. `chat.totalCost` uses the existing usage-based cost (it includes the summary).

- [ ] **Step 4: Run tests and typecheck** → PASS.
- [ ] **Step 5: Commit**: `feat(server): create and read discussions`

---

### Task 5: Turns, host messages, stop and more turns

**Files:**
- Create: `server/src/discussion/turn.ts`
- Modify: `server/src/routes/discussions.ts`
- Test: `server/test/discussionTurn.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4; `checkSpend`; `recordUsage`; `callTimer`, `failureStatus`, `replyErrorMessage`, `saveIfChatExists` from `generate.ts`; `insertMessage`; `setActiveLeaf`/`touchChat`.
- Produces:
  ```ts
  export function streamTurn(c: Context, deps: Deps, chatId: string, onFinish: () => void): Response;
  ```
- Routes:
  - `POST /:id/turn` → SSE stream:
    ```
    start  DiscussionTurnStart
    (delta {text} | reasoning {text})*
    done   DiscussionTurnDone  |  error  DiscussionTurnError
    ```
  - `POST /:id/messages` (body `{ content }`) → 201 `Message`
  - `POST /:id/stop` → `DiscussionState`
  - `POST /:id/more-turns` → `DiscussionState`

**Behavior:**
- **Refusals:** `/turn` checks these before anything is saved, in this order:
  1. `checkSpend(db)` → 402
  2. a turn already in flight for this discussion → 409 `'A turn is still running in this discussion.'` (an in-memory `Set`, as in `generationRoutes`)
  3. status `'ended'` → 409 `'This discussion has ended. Add turns to continue.'`
- **Streaming:**
  - The speaker is `nextSpeaker(...)`.
  - The call is `openrouter.streamChat({ apiKey, model, messages: buildDiscussionPrompt(...), tools: speaker.isModerator ? moderatorTools(...) : undefined, signal })`.
  - Only the first `tool_call` is used.
- **Saving:**
  - On completion, save `cleanReply(text, …)` with `participantId`, `handoffTo` (from `readToolCall`), usage, cost and `status: 'complete'`. The parent is the chat's `active_leaf_id`; then `setActiveLeaf`.
  - `recordUsage({ purpose: 'reply', kind: 'send', compare: false, threadKind: 'discussion', webSearch: false, attachments: 0, … })`.
- **Ending:**
  - If `readToolCall` returned `{ end }`, `setStatus(ended, 'moderator', end)`.
  - Else if `turnsTaken >= turnLimit`, `setStatus(ended, 'limit')`.
  - `done.state` reflects this.
- **Failure:** the partial is saved as `stopped` (when there's any text). `error` carries the message, the partial and the state. The status stays `active`.
- **Host messages:**
  - 409 `'Wait for the current turn to finish.'` while a turn is in flight.
  - Otherwise insert `role: 'user'`, `participantId: null` and advance the active leaf. The status is unchanged.
  - Content is trimmed, 1–20 000 characters, else 400 `'Message is empty.'` / `'That message is too long.'`.
- **Stop:** `setStatus(ended, 'stopped')`. Works whether active or already ended (idempotent).
- **More turns:**
  - Active → `turnLimit + 2`.
  - Ended → limit `turnsTaken + 2` (capped at `MAX_TURN_LIMIT`), status `active`, end reason and note cleared.
  - Ended with `turnsTaken + 2 > MAX_TURN_LIMIT` → 400 `'This discussion has reached the 100-turn maximum.'`.

- [ ] **Step 1: Write failing tests** (scripted `streamChat` via `makeApp`):
  - `it('streams a rotation turn and saves it under the speaker')`
  - `it('applies the moderator handoff to the next turn')`: the moderator's scripted `tool_call` passes to Chicken; the next `/turn`'s `start.participantId` is Chicken's
  - `it('ends with reason moderator and its note on end_discussion')`
  - `it('ends with reason limit when the last allowed turn completes')`: limit 2
  - `it('refuses a turn on an ended discussion with 409')`
  - `it('refuses a turn over a spending limit with 402 and saves nothing')`
  - `it('saves the partial as stopped and keeps the discussion active when the stream fails')`: `streamChat` yields a delta then throws `OpenRouterError` (Review Focus 3)
  - `it('refuses a host message while a turn is in flight')`: hold the stream open on a promise (Review Focus 4)
  - `it('saves a host message on an ended discussion without starting a turn')` (Review Focus 4)
  - `it('more-turns on an ended discussion allows exactly two more turns')`: stop at turn 1 of 10 → limit 3, active
  - `it('more-turns while active adds two to the limit')`
  - `it('records usage with threadKind discussion')`
- [ ] **Step 2: Run them and see them fail**
- [ ] **Step 3: Implement** `streamTurn` and the four routes. Structure: claim, try/finally release, as in `compare.ts`.
- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**: `feat(server): discussion turns, host messages, stop and more turns`

---

### Task 6: Summary and print report

**Files:**
- Create: `server/src/discussion/summary.ts`, `server/src/discussion/report.tsx`
- Modify: `server/src/routes/discussions.ts`
- Test: `server/test/discussionReport.test.ts`, `server/test/discussionTurn.test.ts` (summary cases)

**Interfaces:**
- Produces:
  ```ts
  export async function summarizeDiscussion(deps: Deps, chatId: string, modelId: string): Promise<DiscussionSummary>;
  export function renderReport(d: DiscussionDetail, opts: { generatedAt: number }): string; // full '<!doctype html>…' document
  ```
- Routes:
  - `POST /:id/summary` (body `{ modelId }`) → `DiscussionSummary`
  - `GET /:id/report` → `text/html; charset=utf-8`, with the CSP from Global Constraints

**Behavior:**
- **Summary:**
  - Runs `checkSpend`, then one `openrouter.complete({ maxTokens: 4000 })`.
  - The system message is exactly:
    `Summarize this discussion for the Host. Say what each participant argued, how their positions moved over the discussion, and the outcome, if there was one. Use the participants' names. Keep it under 300 words.`
  - The user message is `Topic: "${topic}"` followed by the transcript, labelled as in the engine. Silent handoffs are skipped.
  - Logged with `purpose: 'summary'` and `threadKind: 'discussion'`.
  - An empty result → 502 `'The model returned an empty summary. Try again or pick another model.'`.
  - Running it again replaces the saved summary.
  - Allowed on active or ended discussions. 409 while a turn is in flight.
- **Report:**
  - Rendered with `renderToStaticMarkup` (`react-dom/server`), using `react-markdown` + `remark-gfm` for message bodies (no `rehype-raw`).
  - Contents:
    - the topic as `<h1>` and the generated date
    - a participants table: name, model, turns, cost (`usd()`)
    - total cost and turns
    - the transcript: each turn has its name in the participant's color and in bold text, so it reads in grayscale
    - silent handoffs as one italic line
    - the summary section, if there is one
  - Print CSS:
    - `@page { margin: 18mm }`
    - `.turn { break-inside: avoid }` (where avoidable)
    - `thead { display: table-header-group }`
  - It has no scripts.

- [ ] **Step 1: Write failing tests**
  - `it('saves and replaces the summary and logs it as a summary call')`
  - `it('renders names, models, costs and the summary into the report')`
  - `it('renders model HTML inert')` (Review Focus 5):
    - content `'<script>alert(1)</script> [x](javascript:alert(1))'`
    - the output has no `<script>alert`
    - it contains `&lt;script&gt;`
    - it has no `href="javascript:`
  - `it('serves the report with the restrictive CSP')`
- [ ] **Step 2: Run them and see them fail**
- [ ] **Step 3: Implement.** If `vitest` can't load `.tsx` from `server/`, add `esbuild: { jsx: 'automatic' }` to `vitest.config.ts`. Confirm `tsx` already runs it in dev.
- [ ] **Step 4: Run tests and typecheck** → PASS.
- [ ] **Step 5: Commit**: `feat(server): discussion summary and print report`

---

### Task 7: Stats, Data tab, export and search on the server

**Files:**
- Modify: `server/src/routes/stats.ts`, `server/src/dataStore.ts`, `server/src/exportData.ts`, `shared/types.ts`
- Test: `server/test/statsRoutes.test.ts`, `server/test/dataStore.test.ts`, `server/test/export.test.ts`

**Interfaces:**
- Produces:
  - `DeleteTarget` gains `'discussions'`
  - `StorageUsage.parts` gains `discussions: number` (message bytes in discussion threads, no longer counted in `messages`)
  - the export folder for kind `discussion` is `discussions`

- [ ] **Step 1: Write failing tests**
  - `it('counts discussion replies in chat stats')`: the filter at `routes/stats.ts:28` includes `'discussion'`
  - `it('deletes all discussions without touching chats')`, and `it('delete chats leaves discussions')`
  - `it('splits discussion text into its own storage part')`: `total` is unchanged by the split
  - `it('exports a discussion with speaker names')`:
    - path `discussions/<title>-<id8>.md`
    - each turn as `**Egg-Defender** (model): text`
    - host lines as `**Host**: text`
    - the summary at the end under `## Summary`
  - `data.json` includes the `discussions` and `discussion_participants` rows
- [ ] **Step 2: Run them and see them fail**
- [ ] **Step 3: Implement.** In `threadMarkdown`, branch on `chat.kind === 'discussion'`, reading participants from the store.
- [ ] **Step 4: Run tests and typecheck** → PASS.
- [ ] **Step 5: Commit**: `feat(server): discussions in stats, Data tab and export`

---

### Task 8: Web plumbing: route, mode, API client, loop logic

**Files:**
- Modify: `web/src/lib/route.ts`, `web/src/components/Sidebar.tsx`, `web/src/App.tsx`, `web/src/api.ts`
- Create: `web/src/lib/discussionLoop.ts`, `web/src/lib/discussionLoop.test.ts`, `web/src/lib/discussion.ts`, `web/src/lib/discussion.test.ts`, `web/src/pages/DiscussionPage.tsx` (placeholder that renders "Discussion" for now)
- Test: existing `web/src/lib/route` tests (if present) plus the new ones

**Interfaces:**
- Route: `{ page: 'discussions'; discussionId: string | null }`, hash `#/discussions` and `#/discussions/:id`.
- Sidebar: `MODES` gains `{ id: 'discussion', label: 'Discussions' }`, `HOME.discussion = '#/discussions'`, new label `'New discussion'`.
- `api` gains:
  - `createDiscussion(d: NewDiscussion): Promise<DiscussionDetail>`
  - `getDiscussion(id)`
  - `postHostMessage(id, content): Promise<Message>`
  - `stopDiscussion(id): Promise<DiscussionState>`
  - `moreTurns(id): Promise<DiscussionState>`
  - `summarizeDiscussion(id, modelId): Promise<DiscussionSummary>`
  - `discussionReportUrl(id): string`
- `streamDiscussionTurn(id: string, h: { onStart(e: DiscussionTurnStart): void; onDelta(t: string): void; onReasoning(t: string): void; onDone(e: DiscussionTurnDone): void; onError(e: DiscussionTurnError | { message: string; status: number }): void }, signal: AbortSignal): Promise<void>`. HTTP errors pass `status` (402 matters).
- `discussionLoop.ts`:
  ```ts
  export type LoopMode = 'running' | 'paused' | 'ended';
  export interface LoopState { mode: LoopMode; streaming: boolean; queued: string[]; error: string | null; spendBlocked: boolean }
  export type LoopEvent =
    | { type: 'resume' } | { type: 'pause' } | { type: 'turnStarted' }
    | { type: 'turnDone'; state: DiscussionState } | { type: 'turnFailed'; message: string; spend: boolean }
    | { type: 'hostTyped'; text: string } | { type: 'hostSent' } | { type: 'stopped' } | { type: 'turnsAdded'; state: DiscussionState; wasEnded: boolean };
  export function initialLoop(state: DiscussionState, justCreated: boolean): LoopState; // running if justCreated && active; ended if ended; else paused
  export function loopReducer(s: LoopState, e: LoopEvent): LoopState;
  export function nextAction(s: LoopState): 'turn' | 'sendHost' | 'idle'; // streaming → idle; queued → sendHost; running → turn; else idle
  ```
- `discussion.ts`:
  - `cheapestModel(models: LibraryModel[]): LibraryModel | null`: lowest non-negative `completionPrice`, ties broken by `promptPrice`; unknown prices last
  - `turnLabel(s: DiscussionState): string`: `'Turn 7 of 12'`

- [ ] **Step 1: Write failing tests**
  - `it('pauses after the current turn when paused mid-stream')`: `pause` while streaming → mode `paused`, streaming still true; then `turnDone` → `nextAction` is `idle`
  - `it('pauses on a failed turn and does not retry')` (Review Focus 3)
  - `it('marks spend-blocked on a 402 failure')`
  - `it('sends a queued host message before the next turn, and only after the stream ends')` (Review Focus 4)
  - `it('sends a host message on an ended discussion without starting a turn')`
  - `it('turnDone with an ended state ends the loop')`
  - `it('turnsAdded on an ended discussion resumes running')`
  - `it('opens an existing active discussion paused')`
  - `cheapestModel` and `turnLabel` cases
  - `parseHash('#/discussions/abc')` → `{ page: 'discussions', discussionId: 'abc' }`
- [ ] **Step 2: Run them and see them fail**
- [ ] **Step 3: Implement.** Wire `App.tsx`:
  - `mode` is `'discussion'` on the discussions route
  - `activeChatId` covers it
  - render `<DiscussionPage discussionId={…} models={models} settings={settings} onDiscussionsChanged={refreshChats} />`
  - search results with `chatKind: 'discussion'` open through `threadHref`
- [ ] **Step 4: Run tests and typecheck** → PASS.
- [ ] **Step 5: Commit**: `feat(web): Discussions mode, API client and loop logic`

---

### Task 9: Setup screen

**Files:**
- Create: `web/src/components/discussion/DiscussionSetup.tsx`
- Modify: `web/src/pages/DiscussionPage.tsx`, app stylesheet (where `.compare-*` styles live)

**Interfaces:**
- Consumes: `validateNewDiscussion`, limits, `participantColor` (Task 1); `api.createDiscussion` (Task 8); `models: LibraryModel[]`; tool support from the catalog. `LibraryModel` has no `supportsTools`, so add `supportsTools: boolean` to `LibraryModel` and fill it in `routes/models.ts` from `modelSupportsTools`, with a test in `server/test/models.test.ts`.
- Produces: `DiscussionSetup({ models, onCreated(d: DiscussionDetail): void })`.

**Behavior** (spec "Setup screen", layout from the brainstorm mockup):
- **Topic field:** placeholder `Which came first, the chicken or the egg?`.
- **Starting rows:** two participant rows, named `Participant 1` and `Participant 2`, using the default model.
- **Each row:**
  - a color dot
  - a name input
  - a model select (the library)
  - an instructions textarea, with placeholder `Argue that the egg came first.`
  - a "Moderator" checkbox, shown only when the row's model supports tools; checking it unchecks any other
  - a remove button (hidden at 2 rows)
- **Adding rows:** `+ Add participant`, hidden at 6.
- **Turn order:** below the rows, read-only text: `Order: rotation` or `Order: Moderator picks who speaks`.
- **Turn limit:** number input, default 10.
- **Start discussion:**
  - validates with `validateNewDiscussion` and shows the first error inline (`ErrorText`)
  - posts, then navigates to `#/discussions/:id` with `justCreated` (pass it via `history.state` or a module-level flag; builder's call)

- [ ] **Step 1: Write the failing `models.test.ts` case** `it('lists supportsTools for library models')`, run it (FAIL), add the field, run it (PASS).
- [ ] **Step 2: Build the component and wire it into `DiscussionPage`** for the `discussionId === null` case.
- [ ] **Step 3: Typecheck**: `npx tsc --noEmit` → PASS.
- [ ] **Step 4: Commit**: `feat(web): discussion setup screen`

---

### Task 10: Discussion view

**Files:**
- Create: `web/src/components/discussion/DiscussionView.tsx`, `DiscussionHeader.tsx`, `ParticipantsPopover.tsx`, `DiscussionTranscript.tsx`, `SummaryCard.tsx`
- Modify: `web/src/pages/DiscussionPage.tsx`, `web/src/pages/settings/DataTab.tsx`, stylesheet

**Interfaces:**
- Consumes: Task 8 (`loopReducer`, `nextAction`, `api`, `streamDiscussionTurn`, `cheapestModel`, `turnLabel`), `participantColor`, `Markdown`, `usePopover`, `SpendNotice`, `ErrorText`, `usd`/`format` helpers.

**Behavior** (spec layout A):
- **Header:**
  - the topic, then `turnLabel`, then the total cost
  - participant avatars: initials in their colors; a click opens `ParticipantsPopover`, which shows one row per participant with color, name, model display name, `turns`, `usd(cost)` and an expandable instructions block
  - **+2 turns**
  - **Pause**/**Resume**, depending on loop mode
  - **Stop**: aborts the in-flight turn, then `api.stopDiscussion`
  - **Summarize** and **Print**, shown when paused or ended
- **Transcript:**
  - each message gets an avatar, a name, a muted model label, and the body via `Markdown`
  - moderator messages with `handoffTo` show a `→ Name` tag
  - a silent handoff is a single small line, `Moderator → Egg-Defender`
  - host lines are `You (host)`
  - the streaming turn shows `writing…` and appends deltas; on `done` the saved, cleaned message replaces the streamed text
  - an end banner states the reason:
    - `Reached the turn limit.`
    - `You stopped the discussion.`
    - `The moderator ended the discussion: ${endNote}`
- **Composer:**
  - placeholder `Say something to the room…`
  - send dispatches `hostTyped`
  - the button reads `Send after this turn` while streaming, `Send` otherwise
- **Loop:** a `useEffect` on loop state runs `nextAction`:
  - `'turn'` → `streamDiscussionTurn` with a fresh `AbortController`, dispatching `turnStarted`/`turnDone`/`turnFailed`
  - `'sendHost'` → `api.postHostMessage` for `queued[0]`, then `hostSent`
  - Unmount aborts the controller, which is how closing the page pauses
  - A 402 shows `SpendNotice`'s limit message; other errors show `ErrorText`
- **Summarize:** a small popover with a model select (default `cheapestModel(models)`) and a Summarize button. The result shows as a `SummaryCard` at the end of the transcript, with model and cost.
- **Print:** `const w = window.open(api.discussionReportUrl(id)); w?.addEventListener('load', () => w.print())`.
- **Data tab:**
  - a `Discussions` storage line
  - a `DELETES` entry: target `'discussions'`, button `Delete all discussions`, title `Delete all discussions?`, body `Every discussion and its transcript and summary will be deleted. This can't be undone.`
  - the `deleted()` note wording for discussions: `Deleted N discussion(s).`

- [ ] **Step 1: Build the components and wire `DiscussionPage`** for `discussionId !== null`. Load with `api.getDiscussion` and set the loop with `initialLoop(state, justCreated)`.
- [ ] **Step 2: Typecheck and run the full suite**: `npx tsc --noEmit && npx vitest run` → PASS.
- [ ] **Step 3: Commit**: `feat(web): discussion view, participants popover, summary and print`

---

### Task 11: Browser verification

- [ ] **Step 1: Start a dev server on another port.**
  - Add a `.claude/launch.json` entry that runs `npm run dev` with `OPENCHAT_PORT=3100` (match how earlier plans did this), and start it with `preview_start`.
  - Never use port 3000.
- [ ] **Step 2: Check without paid calls:**
  - the setup validation messages
  - the Discussions mode in the sidebar
  - the Data tab line
  - an empty-state discussion page
- [ ] **Step 3: Ask the user before paid checks.**
  - Plan: a 3-participant moderated discussion on the cheapest tool-capable model, with a 4-turn limit, then Summarize and Print.
  - Estimate the cost from the catalog prices before asking (expected well under $0.05).
- [ ] **Step 4: Run the paid checks once the user says yes:**
  - streaming, the handoff tag, Pause and Resume
  - a host message sent mid-turn (it lands after the turn)
  - Stop, then +2 turns giving exactly two turns
  - the participants popover costs adding up to the header total minus the summary
  - Summarize
  - the Print preview: names readable in grayscale, no split turns where avoidable
  - dark mode
- [ ] **Step 5: Final commit**: any fixes from verification, then `npx vitest run && npx tsc --noEmit`.
