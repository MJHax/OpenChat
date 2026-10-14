# Compare Models & "Remember This" — Design Spec

**Date:** 2026-10-14
**Status:** Approved in conversation (pending spec review)
**Builds on:** `docs/superpowers/specs/2026-10-14-openchat-design.md`

## Purpose

Two additions to OpenChat:

1. **Side-by-side comparison inside a chat.** Send one message to 2–4 models at once, watch the replies stream in columns, and choose which one the conversation continues from. Compare mode stays on for the following turns until it is switched off.
2. **"Remember this".** Turn any message (or a highlighted part of it) into a one-line memory fact, suggested by a configurable cheap model and editable before saving.

## Out of scope

- More than 4 models per comparison.
- Comparing across different prompts (each comparison is one prompt, many models).
- Automatic memory extraction (the user always clicks Remember and approves).
- Saving reasoning text (still live-only, as today).

---

## Part 1: Comparison

### Behavior

- **Compare toggle.** The composer gets a **Compare** toggle next to the model picker. Turning it on replaces the single model picker with a checklist of library models. Exactly 2–4 must be checked to send. The toggle state and checked models are remembered per chat in browser storage (`localStorage`, key `openchat.compare.<chatId>`). A brand-new chat starts with Compare off.
- **Sending in compare mode.** One user message is saved, then every checked model replies to it at the same time. The chat shows one column per model, in the checklist's order. Each column streams independently and has its own "Thinking… Ns" indicator with reasoning toggle, its own error display, and its own token/cost line once finished.
- **Choosing.** Each finished (or stopped) column has **Continue with this one**. Until one is chosen:
  - Send, Regenerate and Edit are disabled, and the composer shows "Pick a reply to continue".
  - The choice is persisted on the chat, so reloading the page shows the columns again.
  - Choosing makes that reply the active branch. The others remain as versions of the same message, reachable with ‹ › like any regenerate.
- **Following turns.** With Compare still on, the next message goes to the same checked models, continuing from the chosen reply. Turning Compare off returns to the single-model picker, which preselects the model of the reply that was chosen.
- **Regenerate and Edit in compare mode.** When Compare is on, regenerating a reply or editing a user message fans out to the checked models in the same way, followed by the same choosing step.
- **Compare versions.** Any reply with more than one version shows a **Compare versions** button. It opens the same column view for all existing versions of that message (no new generation). From there the user can close the view or click **Continue with this one** on any column.
- **Stop.** Stop cancels all columns. Each column with text is saved as a stopped reply; columns with no text save nothing. If at least one reply was saved, the choosing step applies. If none was saved, the user message is left without a reply and the existing "Generate reply" prompt applies.
- **Failures.** A model failing shows its error in its own column; the other columns are unaffected. A failed column has no "Continue" button. If every column fails, the choosing step is skipped and the error state shows, with Retry re-running the comparison.
- **Layout.** In compare view the message area widens to the full width of the main pane (columns of equal width). Below 900 px wide the columns stack vertically.
- **Cost.** Each reply records its own tokens and cost as today. The chat total already sums every version.
- **Titles.** A new chat is titled after its first comparison using the first reply that completed.

### Data model changes

```
chats.compare_parent_id TEXT NULL
  -- set while a comparison's replies are waiting for a choice: the id of the
  -- user message they answer. NULL otherwise.
```

Added to `openDb` as a migration: `ALTER TABLE chats ADD COLUMN compare_parent_id TEXT` when the column is missing (existing databases must keep working).

### Server API changes

**Generation endpoints accept a list of models.** `POST /api/chats/:id/messages`, `/regenerate` and `/edit` accept either `modelId: string` (unchanged behavior) or `modelIds: string[]` with 2–4 distinct non-empty ids. Sending both, or a `modelIds` list outside 2–4, is a 400.

**Compare stream protocol** (only when `modelIds` is used). Events on one SSE response:

| event | data |
|---|---|
| `start` | `{ userMessageId: string \| null, slots: { assistantMessageId: string, modelId: string }[] }` |
| `delta` | `{ slot: number, text: string }` |
| `reasoning` | `{ slot: number, text: string }` |
| `slot-done` | `{ slot: number, message: Message }` |
| `slot-error` | `{ slot: number, message: string, partial: Message \| null }` |
| `done` | `{ compareParentId: string \| null }` — every slot has finished; `compareParentId` is null if no reply was saved |
| `title` | `{ title: string }` (optional, after `done`) |

The single-model protocol is unchanged.

**Server behavior for a comparison:**
- The per-chat "one generation at a time" lock covers the whole comparison and is released once every slot has finished and been saved (before title generation), as today.
- At start: `compare_parent_id` is set to the user message being answered. The active leaf is set to that user message. For regenerate this hides the previous reply until a choice is made.
- Each slot streams from OpenRouter concurrently with the same prompt (persona + active path up to the user message). Each slot saves its own reply as a sibling under the user message: `complete`, or `stopped` with partial text, or nothing.
- At the end, if no slot saved a reply, `compare_parent_id` is cleared.
- A client disconnect aborts every slot; slots with text are saved as stopped.
- `compare_parent_id` stays set until a choice is made (see below).

**Choosing a reply.** `PATCH /api/chats/:id { selectMessageId }` (existing) also clears `compare_parent_id`. The selected reply becomes the active branch, as today.

**Blocked while a choice is pending.** While `compare_parent_id` is set, `/messages`, `/regenerate` and `/edit` return 409 "Pick a reply to continue." (Choosing via PATCH is always allowed.)

**Chat detail.** `GET /api/chats/:id` (and every endpoint returning `ChatDetail`) adds:

```ts
compare: { parentId: string; replies: Message[] } | null
// replies = every assistant reply whose parent is compare_parent_id, oldest first
```

**Versions of a message.** New `GET /api/chats/:id/replies?parentId=<userMessageId>` returns `Message[]`, the assistant replies to that user message, oldest first (400 if the message is not a user message in this chat). The client uses this for **Compare versions**.

**Titles.** The title rule changes from "exactly one complete reply exists" to "the chat is still titled `New chat` and at least one complete reply exists". The transcript sent for titling is the active path plus, if the path ends at a user message, the first complete reply to it. (Consequence: if titling fails, it is retried after the next reply. That costs one cheap call per turn until it succeeds, which is acceptable.)

---

## Part 2: "Remember this"

### Behavior

- Every message (user and assistant) gets a **Remember** button in its footer.
- Clicking it takes the text currently highlighted inside that message, or the whole message if nothing in it is highlighted, and asks the memory model for a suggestion.
- An inline box opens under the message showing "Suggesting…", then the suggested fact in an editable text field, with **Save** and **Cancel**.
- **Save** adds the fact to Memory as an enabled memory (the existing `POST /api/memories`). The box closes and shows "Saved to memory" for 2 seconds.
- **Cancel** closes the box without saving.
- If the suggestion fails (no model configured, OpenRouter error), the box opens with an empty field and the error message, so the fact can be typed by hand.

### Settings

- New setting **Model for memories** in Settings → Other, next to "Model for chat titles". It lists library models plus "Same as default model" (empty value).
- Stored as `memory_model_id`. Exposed as `memoryModelId` in `SettingsView` and `SettingsUpdate`.
- Removing a model from the library clears `memory_model_id` if it pointed at that model (as already done for the title model).

### Server API

`POST /api/memories/suggest { text: string }` → `{ suggestion: string }`

- `text` must be non-empty after trimming (400 otherwise). It is truncated to 4,000 characters.
- Model: `memory_model_id`, else `default_model_id`. If neither is set: 400 "Add a model in the Model Library first."
- No API key: 400 with the same message the chat uses.
- Calls OpenRouter's non-streaming completion with `maxTokens: 1000` (reasoning models need the room, as with titles) and this system prompt:

  > Turn the following text into one short fact worth remembering about the user, written in the third person (for example "User lives in a small farming town."). If the text says nothing about the user, state its key point as a single short fact instead. Reply with the fact only.

- The reply is cleaned to one line (first non-empty line, surrounding quotes and markdown markers removed, at most 300 characters). An empty result is a 502 "The model didn't suggest anything. Type the fact yourself."
- OpenRouter errors return 502 with the friendly OpenRouter message.

---

## Error handling summary

| Situation | Result |
|---|---|
| One compare slot fails | Error in that column; others continue; that column can't be chosen |
| All compare slots fail | No choosing step; error bubble with Retry (re-runs the comparison) |
| Send/regenerate/edit while a choice is pending | 409 "Pick a reply to continue." (UI also disables these) |
| `modelIds` with fewer than 2, more than 4, duplicates or blanks | 400 |
| Memory suggestion fails | Inline box opens empty with the error; user can type the fact |

## Testing

- **Server (Vitest, mocked OpenRouter):**
  - A comparison with 3 models saves 3 sibling replies, sets `compare_parent_id`, emits `slot`-tagged events and a final `done`.
  - One slot failing mid-stream: its partial is saved as stopped and reported in `slot-error`; the others complete.
  - All slots failing before any text: `done` has `compareParentId: null` and `compare_parent_id` is cleared.
  - Client abort: every slot with text is saved as stopped.
  - The lock rejects a second generation during a comparison and releases after it.
  - 409 while a choice is pending; `PATCH selectMessageId` clears it.
  - `modelIds` validation (counts, duplicates, both fields).
  - Regenerate with `modelIds` hides the old reply until a choice is made.
  - `GET /replies` returns all versions and rejects non-user parents.
  - Titles after a comparison.
  - `/memories/suggest`: uses memory model, falls back to default, cleans output, 400/502 cases.
  - Migration: opening a database created without `compare_parent_id` adds it.
- **Web:** unit tests for pure helpers (compare-mode storage parsing, model-list validation).
- **Manual (browser pane, real key):** a 3-model comparison end to end, choose, follow-up turn in compare mode, Stop mid-comparison, Compare versions on an old reply, Remember on a user message and an assistant message (with and without a highlight), Model for memories setting.
