# Discussions: pacing, easier control and a moderator that ends things

Date: 2026-11-08

## Why

The owner ran a moderated debate ("tabs or spaces") with Gemini 2.5 Flash Lite as moderator, told it to end the
discussion after three arguments from each side, and gave it plenty of turns. The moderator wrote a good closing summary,
but the discussion kept going until the turns ran out. It never called `end_discussion`, and the transcript showed
"The moderator isn't choosing speakers, so the normal order is being used." The moderator tools are offered with
`tool_choice: 'auto'`, and small, fast models often answer in text and skip the tool.

The second problem is speed. The owner tells debaters to keep replies under 30 words, so each reply streams in almost
instantly and the next one starts straight away. There's no time to read along, let alone step in. Pause and Stop exist,
but they are small links in the header and easy to miss.

What the owner wants: a debate that feels like watching people talk, that they can jump into at any moment, and that
ends when the moderator says it's over.

## Goals, non-goals, anti-goals

Goals:
- A moderator that reliably picks the next speaker or ends the discussion, even when the model skips the tool call.
- With a moderator, the turn limit is optional: the moderator decides when it's over.
- Pause/Resume and Stop are easy to find while a discussion runs.
- Replies appear at a natural pace that you can read along with, by default.
- Starting to type a message holds the debate, so the host can always get a word in.
- Two simple options, set at setup or mid-debate: how replies appear, and whether it keeps going on its own.

Non-goals:
- Fine-grained speed settings (sliders for reveal speed or pause length). Two options only.
- Changing how the transcript is stored or how turns are counted.
- Per-participant pacing.
- Changing what happens after a host message: with a moderator, the moderator already speaks next
  (`nextSpeaker` in `server/src/discussion/engine.ts`). Keep it that way.

Anti-goals (a failure even if it "works"):
- A discussion that can run and spend money with no end: no limit must still mean a hard cap.
- The reveal making the debate fall behind: the next turn must not start while the previous reply is still appearing.
- Slowing down anything except live viewing: reopening a discussion, printing, the report and exports show full text
  at once.
- More setup friction for people who never touch the options: the defaults must just work.
- Breaking the privacy rule: the moderator's extra decision request goes to the moderator's own model, so a local-only
  discussion stays local.

## The design

### 1. The moderator always decides

Today a moderator turn is one streamed request with `pass_to` and `end_discussion` offered at `tool_choice: 'auto'`.
That stays as the first try: a model that calls the tool behaves exactly as now.

When the moderator's turn ends **without a valid tool call** (no call, or one `readToolCall` rejects), the server makes
one short follow-up request to the same model, before saving the turn:
- the same prompt, plus the moderator's reply as an assistant message, plus a user message asking it to decide now:
  "Who should speak next? Call pass_to with their name, or end_discussion if the discussion is finished."
- the same two tools, with `tool_choice: 'required'` where the provider supports it (OpenRouter, LM Studio and
  OpenAI-compatible servers). Ollama has no `tool_choice`; it gets the tools and the instruction as they are.
- not streamed to the browser. The browser can show the moderator's status as "deciding…" while it runs.

If the follow-up returns no valid call, the server reads its text as a fallback: a reply that is just a participant's
name (as `matchParticipant` matches names) is a handoff; a reply that says END (any case, alone on the line) ends the
discussion. Anything else counts as a miss, as today, and the existing "isn't choosing speakers" note and rotation
fallback still apply.

*Builder's call (by the design author):* the moderator must still be a model with tool support, as today
(`createDiscussion` and the setup form both enforce it). The plain-text reading above is only a safety net for a model
that ignores the tools; this change does not open the moderator role to tool-less models.

The follow-up's tokens and cost are added to the moderator's message (its `promptTokens`, `completionTokens`, `cost`)
and recorded in usage like any reply, so per-participant cost and the spending stats stay right. It does not count as
a separate turn. If the turn is stopped or aborted, no follow-up is made.

A moderator's end now takes effect after its text: its wrap-up is saved and shown, then the discussion ends with reason
"moderator", as an `end_discussion` call does today.

### 2. Optional turn limit with a moderator

On the setup form, when one participant is the moderator, the turn limit gets a choice: **Let the moderator decide**
(the default when there is a moderator) or **Stop after N turns** (today's field). Without a moderator the field is
required, as now.

"Let the moderator decide" is stored as a turn limit of `MAX_TURN_LIMIT` (100) with a new flag on the discussion
(`moderator_decides`, default 0, added with the same `ALTER TABLE` migration pattern as `moderator_misses`). Hitting 100
still ends the discussion with reason "limit". While the flag is set:
- the header shows "Turn 5" instead of "Turn 5 of 100"
- **+2 turns** is hidden while the discussion is active. After it ends, **+2 turns** works as today, so the host can
  keep it going after the moderator ends it.

*Author's call:* using **+2 turns** on an ended discussion clears `moderator_decides`. From then on it is an ordinary
limited discussion ("Turn 31 of 32") and **+2 turns** shows and works as it does for any limited discussion. The flag is
only ever set at creation and only ever cleared by **+2 turns**.

### 3. Controls you can find

Pause/Resume and Stop move out of the header links into real buttons in the bar under the message box, next to Send,
while the discussion is active. Stop stays visually "danger". In **Wait for me** mode (below), a **Next** button sits
there too. The header keeps **+2 turns**, **Summarize** and **Print**.

An options button (a small icon button in that same bar) opens a menu with the two options below, so they can be
changed mid-debate.

### 4. Typing holds the debate

While the message box has text in it, the browser does not start the next turn. A turn already streaming finishes
normally. The status line says something like "Waiting for you to send your message." Sending the message (which, with
a moderator, makes the moderator speak next) or clearing the box lets the debate continue. This is a hold, not a pause:
it releases itself, and it does not change Pause/Resume. In the loop (`web/src/lib/discussionLoop.ts`), this belongs
in `nextAction`: no new turn while the draft is non-empty.

### 5. Two options

**Show replies**
- **Naturally** (default): live replies appear word by word at about 6 words per second. If a reply is long, the
  reveal speeds up so no reply takes more than about 10 seconds to appear (rate = max(6 words/s, words received so far
  ÷ 10 s), recomputed as text arrives). If the model streams slower than the reveal, you see its real pace. Clicking a
  reply that is still appearing shows the rest at once. After a reply has fully appeared, wait about 1 second before
  the next turn starts.
- **Instantly**: as today. Text shows as it streams, and the next turn starts as soon as the last one is saved.

**After each reply**
- **Keep going** (default): as today.
- **Wait for me**: after each reply (and its reveal), the loop waits for **Next**. Sending a host message also counts
  as Next: the next turn (the moderator's, if there is one) starts once it is sent.

*Author's call:* the 1-second beat and **Wait for me** apply only to turns that showed text. A silent moderator turn
(a handoff with no text) flows straight into the next speaker, with no beat and no Next, so the host clicks Next once per
visible reply. A moderator turn with text is a visible reply like any other.

The reveal is display only. The server saves the full reply as soon as the stream ends, as today. In the browser, a turn
counts as done for the loop only when the stream has ended and the reveal has finished (plus the beat). Pause during a
reveal lets the reveal finish and starts no new turn. Stop during a reveal shows everything received at once.

Both options are set:
- in a collapsed **Options** section at the bottom of the setup form, and
- in the options menu while the discussion runs.

They are browser preferences, saved in `localStorage` like the existing preferences in `web/src/lib/chatPrefs.ts`
(read and write wrapped so a blocked storage falls back to the defaults). The last choice becomes the default for the
next discussion. They are not stored on the discussion and are not sent to the server.

## Constraints

- Every existing rule in the discussion tab design (`2026-10-18-discussion-tab-design.md`) still holds: spending
  limits, models never seeing each other's instructions, one linear transcript, local-only discussions staying local.
- The follow-up decision request must go through the same provider layer (`chatProvider`) as the turn itself, and
  respect the turn's abort signal.
- A discussion opened later still starts paused (`initialLoop`), so nothing spends unwatched.
- Tests: server behavior gets tests in `server/test/discussion*.test.ts` against fake servers, as now; the loop changes
  get tests in `web/src/lib/discussionLoop.test.ts`; the reveal rate is a pure function with its own tests.

## Left to the builder

- Exact wording of the decision prompt, status lines and button labels, within the intent above.
- How the reveal is implemented (a timer over the received text is enough; no animation library).
- Layout details of the control bar and options menu, matching the app's existing style in light and dark mode.
- Whether the "deciding…" status is a new SSE event or reuses the existing `status` event.
