# Discussion tab: models talking to each other

Date: 2026-10-18

## Why

The owner wants to set up a conversation between several models, for example a debate on "which came first, the
chicken or the egg?" with one model defending each side, and then watch where it goes. It's for curiosity, not for
getting a verdict. They mostly expect to step in when it runs too long, but they also want to be able to say something to
the models mid-discussion ("wrap it up", "you're going in circles").

Beyond two debaters, they want to design the room: every participant is a model plus instructions they write. One
participant can be a moderator who decides who speaks next. Another can be an analyst who critiques the others' theories.

## Goals, non-goals, anti-goals

Goals:
- Set up a discussion with 2 or more participants, each with a name, a model and private instructions.
- Watch it stream live, turn by turn, in a transcript that reads like a group chat.
- Step in at any time: pause, stop, add turns, or post a message as the host.
- Optionally hand turn order to a moderator model that uses tools to pick the next speaker or end the discussion.
- Know the cost at all times, in total and per participant, and never go past the spending limits.
- When it's over, have a cheap model summarize it, and print a clean report to PDF.

Non-goals (v1):
- Branching, editing or regenerating turns. A discussion is one linear transcript.
- Moderator tools beyond "pick next speaker" and "end discussion". The owner has no other ideas yet, but the tool
  mechanism should make adding more later straightforward.
- Tools for non-moderator participants (web search, etc.).
- Changing participants after a discussion has started.
- Addressing a host message to one participant. Everyone sees host messages; the moderator (or rotation) decides
  who answers.
- A server-generated PDF. No headless browser.
- Attachments in discussions.

Anti-goals (would be a failure even if it "works"):
- A discussion that keeps running and spending money with no way to stop it, or past a spending limit.
- Shipping Chromium/Puppeteer with OpenChat. The owner said no to this explicitly.
- Models seeing each other's instructions. Each model sees only its own.
- Models that blur together: one model writing the other side's lines, or the transcript losing track of who said what.

## Decided by the owner

- **New Discussion tab**, next to Images and Video, with its own list of past discussions.
- **Participants have names** that everyone sees ("Egg-Defender", "Chicken-Defender", "Moderator"). The same model can
  appear more than once, including debating itself. More than two participants is supported.
- **Instructions are private.** Each model sees only its own instructions, plus the names of the others.
- **Two turn-order modes:** fixed rotation, or a moderator participant that picks who speaks next using tools.
- **Layout A, group chat** (mockup in the brainstorm):
  - Header: topic, "Turn N of M", total cost, a participants popover, **+2 turns**, **Pause**, **Stop**.
  - Participants popover: one row per participant with color, name, model, turns taken and cost so far.
  - Transcript: one column, each line with a colored avatar, a name and a muted model label. The moderator's handoff
    shows as a "→ Egg-Defender" tag. Host lines read "You (host)". The live reply streams with "writing…".
  - Composer: "Say something to the room…". The message goes in after the current reply finishes.
- **Setup screen before start:** topic, participant rows (name, model, instructions), **+ Add participant**, a
  moderator toggle, turn limit, **Start discussion**. The moderator toggle and turn order are one setting (my call):
  with no participant marked as moderator, turns go in rotation. Marking one participant as moderator switches the
  discussion to "moderator picks". At most one participant can be marked.
- **Summarize** when it ends: a cheap model summarizes the discussion and its outcome, if there is one.
- **Print:** the backend fills an HTML report template with the transcript and stats and serves it as a page. The
  browser's print dialog ("Save as PDF") makes the PDF. No headless browser.

## How it behaves

### What each model sees

A participant's prompt is built fresh every turn:

1. **System message:** who it is, who else is in the room (names only), that the person watching is the Host, its own
   instructions, the topic, and "Write only your own reply. Don't write lines for anyone else, and don't start with your
   name." For example:
   > You are Egg-Defender. You're in a discussion with Chicken-Defender and Moderator about: "Which came first, the
   > chicken or the egg?". The person watching is the Host, who may step in. *(instructions)* Write only your own reply…
2. **History:** its own past turns are `assistant` messages. Everything said by others since its previous turn (other
   participants, the moderator, the host) goes into one `user` message, each part labelled `**Name:** text`. This keeps
   strict user/assistant alternation, which some providers require.
3. **Closing cue:** the last user message ends with `It's your turn, <Name>.` The cue is the same every turn and does
   not say "the moderator allows you". In moderated mode the moderator's words carry the handoff.

The existing `withCacheMarkers` applies, so long discussions benefit from prompt caching.

### Cleaning replies

- Strip a leading `Name:` or `**Name:**` matching the speaker's own name.
- If a reply starts a line that labels another participant (`\nChicken-Defender:`), cut it there. Do this while
  streaming if practical, or else on save (the builder decides which).

### Turn order

- **Rotation:** participants speak in setup order, A → B → C → A…
- **Moderated:** exactly one participant is the moderator. It needs a model that supports tools (`supports_tools`). The
  toggle is hidden for models without tool support. The moderator opens the discussion. After every other participant's
  turn, the moderator takes a turn. It may say something, or say nothing and just hand off. It has two tools:
  - `pass_to(name)`: picks the next speaker. It can't pick itself.
  - `end_discussion(reason)`: ends the discussion; the reason shows in the transcript.
  If the moderator calls neither tool or names someone who doesn't exist, fall back to the next participant in
  rotation order (skipping the moderator). The discussion never stalls.
- A moderator turn with no text and only a handoff shows as a small "Moderator → Egg-Defender" line, not a full
  message.

Tool calls go through OpenRouter's standard function-calling format. Today `streamChat` only handles OpenRouter's
built-in web search tool, so it needs to send custom function tools and surface streamed `tool_calls` as a new stream
event. The moderator's turn ends when it makes a tool call. Nothing needs to be sent back to the model as a tool
result. When later prompts show its earlier handoffs, they can be written as plain text (for example "(You passed the
floor to Egg-Defender.)") instead of tool-call/tool-result pairs. The builder decides which.

### Turn limit and counting

- The owner sets a turn limit at setup. The default is 10.
- A **turn** is one spoken reply by any participant, including the moderator when it says something. A silent moderator
  handoff doesn't count as a turn, but its cost does count everywhere.
- When the limit is reached the discussion stops and shows as ended.
- **+2 turns** while running raises the limit by two.
- **+2 turns** on an ended discussion sets the limit to *turns taken + 2* and resumes it. This works however it ended:
  turn limit, Stop, or the moderator's `end_discussion`. So pressing it always buys exactly two more turns, never more
  (my call).

Statuses: **running**, **paused** (by the host, a closed page, or a spending limit), **ended** (turn limit, Stop, or
moderator). Only Resume (from paused) and +2 turns (from either) start turns again.

### Host controls

- **Pause:** the current reply finishes, then no new turn starts. **Resume** continues.
- **Stop:** aborts the reply in progress (the partial text is saved as stopped, as chat does today) and ends the
  discussion. A stopped discussion can be resumed with +2 turns.
- **Host message:** if a reply is streaming, the message is queued and inserted after it finishes. Otherwise it's
  inserted right away. If the discussion is running, the next turn runs as usual. If it's paused or ended, the
  message is only added to the transcript and waits for Resume or +2 turns. Posting never restarts spending by itself
  (my call). Every participant sees it, labelled **Host**.
- **Closing the page** pauses the discussion. The reply in progress may finish or be cut off. Nothing keeps running
  unwatched. (Builder's call on mechanism; see below.)

### Spending limits

`checkSpend` runs before each model call. If a limit is reached, the discussion pauses and shows the same limit notice
as chat (including the 80% notice behaviour). A turn is never cut off mid-stream by a limit.

### Ending: Summarize

- An ended discussion (limit, stop, or moderator's `end_discussion`) shows **Summarize** and **Print** in the header.
  Summarize is also available while paused.
- Summarize opens a small model picker that defaults to the cheapest chat model in the library (by completion price).
  The prompt asks for what each participant argued, how positions moved, and the outcome if there was one.
- The summary shows as a card at the end of the transcript and is saved with the discussion. Running it again replaces
  it. Cost is recorded as `purpose: 'summary'`, as "Summarize and continue" does.

### Ending: Print

- A report page, served by the server (e.g. `GET /api/discussions/:id/report`), renders an HTML template with:
  - the topic and date
  - a participants table (name, model, turns, cost)
  - total cost and turn count
  - the full transcript with names and colors
  - the summary, if there is one
- **Print** opens it in a new tab and calls `window.print()`. The page has print styles: no replies split across pages
  where avoidable, readable in black and white (names, not only colors), and no app chrome.
- Reply text is markdown and must render as formatted HTML in the report. All model text is untrusted and must be
  escaped/sanitized, since it's served as an HTML page.

## Constraints

- Single-user, local app. Stack as today: Hono server, SQLite, React web app, everything through OpenRouter.
- Build on existing pieces where they fit:
  - `streamComparison` (`server/src/compare.ts`) for streaming, saving, usage recording and abort handling.
  - `recordUsage` for every model call.
  - `checkSpend` / `spendBlock` for limits.
  - `withCacheMarkers` for prompt caching.
  - `ChatStatsPopover` for the look of the participants popover.
- Discussions appear in usage stats like other chats. Deleting one removes its messages and participants.
- In the Data tab, discussions are their own type, next to chats, images and videos (my call). They get their own
  storage line, their own "Delete all discussions", and their own group in the export. "Delete all chats" doesn't touch
  them; a full reset does.
- Participant names must be unique within a discussion and non-empty. Up to 6 participants (my call; see below).

## Calls I made (the owner hasn't confirmed these)

- Default turn limit of 10.
- On an ended discussion, +2 turns gives exactly two more turns, however it ended.
- A host message on a paused or ended discussion waits; it doesn't restart it.
- The moderator toggle is the turn-order setting. There's no separate rotation/moderator switch.
- Discussions are their own type in the Data tab.
- Silent moderator handoffs don't count toward the turn limit.
- The moderator opens moderated discussions. It speaks between every other turn.
- Fallback to rotation when the moderator doesn't pick validly.
- Closing the page pauses the discussion rather than letting it run on the server.
- Up to 6 participants.
- Summary model defaults to the cheapest chat model in the library. Re-running replaces the summary.
- Each participant gets a fixed color from a small palette, assigned by position.
- Pause lets the current reply finish. Stop cuts it off.

## Left to the builder

- **Where the loop runs.** Two options:
  - The client asks for one turn at a time over SSE (like compare): pause means not asking for the next turn, and
    closing the page stops it naturally.
  - A server-side loop the client subscribes to, which must then detect that no viewer is connected and pause.
  The client-driven option looks simpler and fits "nothing runs unwatched".
- **Schema.** Likely:
  - a new `ThreadKind` value `'discussion'`
  - a table for discussion settings (topic, order mode, turn limit, status, summary and its model and cost)
  - a participants table (position, name, model, instructions, is_moderator)
  - a `participant_id` column on `messages`, plus a handoff target for moderator turns
  Host messages can stay `role: 'user'`. Exact shape is the builder's call, with a migration in `db.ts` as for past
  features.
- How to render markdown on the server for the report (a small library such as `marked` plus sanitizing is fine).
- How replies are cleaned (during streaming or on save).
- The exact system prompt and summary prompt wording, within the rules above.
- Empty states, error copy and the setup screen's validation messages, following the existing app's style.
