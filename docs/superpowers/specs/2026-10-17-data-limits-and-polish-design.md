# Data tab, spending limits, context continuation, per-chat instructions, and review fixes

Date: 2026-10-17

## Why

OpenChat is a single-user, local chat app whose owner watches cost closely and expects to keep using it for a long time.
A review of the app on 2026-10-17 turned up a few small bugs and some gaps:

- There's no way to see how much disk space OpenChat uses.
- There's no way to export data.
- Deleting is not real deletion: SQLite leaves deleted bytes in the file.
- There's no guard against overspending.
- A chat that fills its context window has nowhere to go.
- Instructions can only be set globally.

This work closes those gaps. It's seven pieces that can be built and shipped independently, in any order.

## Pieces at a glance

| # | Piece | User decisions? |
|---|-------|-----------------|
| 1 | Review fixes (video double-submit, endless download retry, stale browser keys) | No, builder's call |
| 2 | Prompt caching for models that need explicit cache markers | No, builder's call |
| 3 | Settings tabs + Data tab (storage, export, delete, full reset) | Yes, below |
| 4 | Spending limits | Yes, below |
| 5 | Context warning + "Summarize and continue" | Yes, below |
| 6 | Per-chat instructions | Yes, below |

Pieces 1 and 2 are listed as one row each, but piece 1 is three small independent fixes.

## Goals, non-goals, anti-goals

Goals:
- "Delete" means the content is gone from disk, not just hidden.
- Spending can be capped by day, week and/or month.
- A long chat can continue in a fresh one without losing the thread.
- Pay less for repeated prompt prefixes where providers support caching.

Non-goals:
- Importing an export back into OpenChat. The export includes JSON so this stays possible later, but import is not built now.
- Per-category budgets (separate limits for chat vs images vs video).
- Automatic summarization. The user always clicks.
- Cloud sync or multi-user anything.

Anti-goals (would be a failure even if it "works"):
- Deleted chat text still recoverable from `data/openchat.db` or its WAL file.
- A spend limit that silently interrupts a reply mid-stream and leaves a half answer.
- A reset button that's easy to hit by accident.
- Stats breaking (crashes, wrong totals) after chats are deleted.

## 1. Review fixes (builder's call)

1. **Video double-submit.** `startVideoGeneration` (`server/src/videoJobs.ts`) checks "a clip is still rendering" before awaiting `openrouter.submitVideo`, but inserts the job row after it. Two near-simultaneous requests (two tabs) can both submit and both be charged. Fix by claiming the thread before the await, for example with an in-memory per-thread lock or a placeholder row, and releasing it on failure. Add a test that fires two requests concurrently and expects one 409.
2. **Endless download retry.** When a finished clip's download keeps failing, the poller retries every 5 minutes forever. Cap it (suggestion: give up after ~24 h of failed downloads). Mark the message as errored with a clear message that says the clip was likely charged, and record the media event as complete with its cost so stats stay right.
3. **Stale browser keys.** The per-chat compare and web-search settings in `localStorage` (`web/src/lib/compare.ts`, `web/src/lib/search.ts`) are never removed when a chat is deleted. Remove them on delete, and in the Data tab deletes.

## 2. Prompt caching (builder's call)

The usage log shows 0 cached tokens so far. Through OpenRouter, Anthropic (Claude) models only cache when the request carries explicit `cache_control` breakpoints. Some other providers (e.g. Gemini) also take explicit breakpoints, while OpenAI and DeepSeek models cache automatically.

- Add breakpoints for models that need them. Suggested: one on the system message, and one on the last message of the history before the new user turn, which is the longest stable prefix.
- Check OpenRouter's current prompt-caching docs for the exact request shape and which model families need it. Don't rely on memory.
- Keep plain-string message content for everything else, so prompts for other models are unchanged.
- Verification: a test that the request body carries the breakpoints for an Anthropic model and not for others. Then one real two-turn chat with a cheap Claude model, checking that `cached_tokens` is non-zero on the second reply. Ask the user before spending on that.

## 3. Settings tabs and the Data tab

### Layout (user decided)

Settings becomes tabbed: **General**, **Memory**, **Data**.
- General: API key, Personalization, Other, plus the new Spending limits section (piece 4).
- Memory: today's Memory section.
- Data: new.

Each tab has its own URL (e.g. `#/settings/data`) so other parts of the app can link straight to a tab and section. Spending-limit errors link to `#/settings/general` at the limits section.

### Storage (user asked to see MB/GB)

Show the total disk use and a breakdown: chat messages, uploaded attachments, generated images, videos, and space that's reclaimable from deleted content. Use MB or GB as appropriate, with a stacked bar plus labeled rows (the same visual language as the Context popover).

- "Reclaimable" is the database's free pages (`freelist_count × page_size`) plus the WAL file's size.
- A **Clean up** button runs a WAL checkpoint (TRUNCATE) and `VACUUM` to give the space back. It shows "Working…" while it runs, since VACUUM rewrites the file.
- Builder's call: how to measure each category. SUM of blob lengths per table/kind is fine. Videos are files in `data/videos/`.

### Export (builder's defaults; the user didn't object)

One **Export all data** button downloads a single `.zip` containing:
- Each chat (and image or video thread) as a readable Markdown file.
- A JSON file with all chats, messages, memories, personalization and settings, but without the API key.
- Every attachment, generated image and video as files.

The zip is streamed so large exports don't load everything into memory. Builder's call: the library (or a hand-rolled store-only zip writer), file naming, and folder layout.

### Delete (user decided)

Four actions. Each one opens a confirmation where the user types `DELETE`.

| Button | Removes | Keeps |
|---|---|---|
| Delete all chats | every chat-kind thread, its messages, attachments, generated files, search index entries, per-chat browser keys | images, videos, memories, settings, stats |
| Delete all images | every image thread and its images | everything else |
| Delete all videos | every video thread, its clip files, finished video job rows | everything else |
| **Delete all my data** | everything: all threads and files, memories, personalization (About me, custom instructions), the API key stored in Settings, model libraries and default/title/memory model choices, theme, spending limits, **stats and cost history** (`usage_events`, `media_events`) | nothing. OpenChat is back to a fresh install |

- The first three deletes keep stats and costs. Stats store no message content, so they stay as they are. A deleted thread's title is gone, so stats lists show "Deleted chat" (check that this already renders that way).
- Before deleting videos, refuse while a clip is still rendering, or cancel locally and warn, since it's already paid for. Builder's call; the safe default is to refuse with a message.
- "Delete all my data" is visually separated as a danger action, with its own stronger confirmation text listing what goes.

### Making delete real (applies to all deletes, including normal chat delete)

- Turn on `PRAGMA secure_delete = ON` at startup, so freed pages are zeroed.
- After any delete from the Data tab, run `PRAGMA wal_checkpoint(TRUNCATE)`, so deleted content doesn't linger in the WAL. Do the same after a normal single-chat delete (cheap enough at this scale).
- The FTS5 search index is external-content with delete triggers. Verify that cascaded deletes clear it. A test can search for a deleted message's unique word and expect no hit.
- Builder verification: write a unique marker string in a chat, delete the chat, checkpoint, then confirm the bytes no longer appear in `openchat.db` or `openchat.db-wal`.

### API key from `.env` (my call)

If the key comes from `.env` rather than Settings, the reset can't remove it, because OpenChat doesn't own that file. The reset confirmation says so in that case.

## 4. Spending limits (user decided, with marked guesses)

- Optional **daily**, **weekly** and **monthly** limits in USD, each enabled and set separately in Settings › General › Spending limits. All are off by default.
- Any combination can be on. Whichever is exceeded first blocks.
- **What counts:** everything OpenChat spends. That's chat replies (including compare runs), titles, memory suggestions, images and videos, which is the same total the Stats page shows.
- **Periods: calendar, not rolling.** The user asked for the error to say *when the limit resets*, and only calendar periods have a single reset time. So the periods are the local calendar day (from midnight), the week (from Monday 00:00, *my call*), and the month (from the 1st), in the user's time zone. The server needs that time zone, so store it with the limits when they're saved.
  - This is new code. `server/src/statsTime.ts` uses *rolling* 7- and 30-day windows for the Stats page's Week and Month, and its heatmap weeks start on Sunday.
  - *My call:* leave the Stats page alone, and label the limits clearly ("Today", "This week (since Monday)", "This month") so the user doesn't expect them to match the Stats page's rolling Week and Month.
  - The 80% notice is dismissed until that limit's period resets.
- **When a limit is reached:**
  - Anything already running finishes. Nothing is interrupted.
  - **Videos:** before submitting, compare the clip's estimated price against what's left. Refuse if it would go over.
  - **Images:** treat the same way if a price estimate exists, otherwise check like chat.
  - **Any new request** (send, regenerate, compare, image, video, title, memory suggestion) is refused with an error that says which limit, when it resets (date and time), and links to the limits section. Titles and memory suggestions fail quietly: no title, or a short message in the Remember box.
- **Early warning (my guess):** at 80% of any enabled limit, a small non-blocking notice near the composer, dismissible for that period.
- The check happens server-side, so every path is covered. The client shows the error the server returns.

## 5. Context warning and "Summarize and continue"

- **Warning (my guess on the threshold):** when the Context popover's fill for the current model reaches 80%, the Context button turns amber and a small notice appears above the composer. At 100% and above, the button is red, as it is today.
- **Summarize and continue (user decided: a short summary):** offered in the notice and inside the Context popover.
  - **Model (my guess):** the chat's current model writes the summary, because it's guaranteed to fit the conversation. It costs about one reply and counts toward spending limits.
  - **Prompt:** a short summary of what the chat is about, decisions made, and open questions. Plain prose, a few short paragraphs at most.
  - **New chat:** it opens with the summary shown as an editable note at the top, labeled as context from the previous chat, with a link back. The note is sent as context with the first message. The original chat is untouched.
  - **Carried over (my guess):** the latest version of each file the chat generated, and the chat's per-chat instructions (piece 6). Uploaded attachments are not carried.
  - **How files carry over (my call):** generated files only exist as `<file name="�">` blocks inside assistant messages (`shared/files.ts`). So the new chat starts with a seed **assistant** message that holds the latest version of each file as file blocks. That way they appear in the file panel and picker, can get new versions in the new chat, and are counted in the Context popover like any history. The summary note itself contains only prose.
- Builder's call: how the note is stored. A first user/system-ish message or a chat-level field are both fine, as long as it's editable before the first send and counted in the Context popover.

## 6. Per-chat instructions (user decided: they add to global ones)

- An **Instructions** button in the chat header opens a small editor for this chat's instructions.
- They're sent **in addition to** the global custom instructions, after them, under a label like "Instructions for this chat". The global ones still apply.
- Stored per chat in the database. Included in the Context popover's System prompt count and in the export.
- **Carried over by "Summarize and continue" (my guess).**
- Also available on a new, unsaved chat. Builder's call how: e.g. held in the client until the chat is created.

## Constraints

- Every model call still goes through OpenRouter. The server listens only on 127.0.0.1 and refuses non-local Host headers.
- Tests: Vitest, matching the existing style (`server/test`, `web/src/lib/*.test.ts`). Every piece adds tests.
- Keep each file's existing line endings. The repo mixes CRLF and LF.
- Commit style: `feat(web): …` / `fix(server): …`, ending with the Co-Authored-By trailer.
- Any paid verification (real API calls) needs the user's OK first, with an estimated cost.
- The user runs their own server on port 3000. Don't kill it. Verify on other ports (`OPENCHAT_PORT` is honored by both the server and the Vite proxy).

## Left to the builder

Everything marked "builder's call" above, plus:
- Exact copy for the messages.
- Component structure.
- Schema changes and migrations (follow the existing `CREATE TABLE IF NOT EXISTS` + additive migration pattern in `server/src/db.ts`).
- Build order of the pieces.
