# Web Search — Design Spec

**Date:** 2026-10-16
**Status:** Decisions approved in conversation (pending spec review)
**Builds on:** `docs/superpowers/specs/2026-10-14-openchat-design.md`, `docs/superpowers/specs/2026-10-14-compare-and-remember-design.md`, `docs/superpowers/specs/2026-10-16-file-attachments-design.md`

## Purpose

Let a reply use current information from the web. OpenRouter runs the searches; OpenChat decides when search is allowed, sends the right request, shows the sources, and keeps the cost visible.

## Decisions made in conversation

- **The model decides when to search.** Models that support tools get OpenRouter's `openrouter:web_search` server tool, so they search zero or more times as needed. Models without tool support fall back to the `web` plugin, which searches once per reply.
- **A per-message toggle in the composer**, remembered per chat (like Compare). Off by default.
- **Default search provider** (`engine` left unset: the model maker's own search where it has one, otherwise Exa), with **at most 3 searches per reply**.

## What a real request showed (probe, 2026-10-16)

Streamed requests against OpenRouter with DeepSeek V4.1 Flash and Claude Haiku 5.5:

- Sources arrive as `choices[0].delta.annotations`, entries of `{ type: 'url_citation', url_citation: { url, title, content, start_index, end_index } }`. `start_index`/`end_index` were always 0, so citations can't be placed in the text; they can only be listed. The same URL can arrive more than once.
- `usage.cost` already includes the search fee (e.g. $0.0010 of tokens + 2 searches × $0.007 = $0.0150). No extra cost handling is needed.
- `usage.server_tool_use_details.web_search_requests` gives the number of searches for the tool. The plugin does not report it (it always searches once).
- With the tool, "Say hi in three words." ran no search and cost $0.0001.
- The stream has no "searching now" event; it only carries content, reasoning and annotations.
- The tool, the plugin and native (Anthropic) search all come back in the same shape.

## Out of scope

- Choosing the search provider, domain filters, X/Twitter search, or changing the 3-search cap in Settings.
- Inline citation markers in the reply text (OpenRouter gives no positions).
- A live "searching now" status (the stream doesn't say).
- Search in title generation and memory suggestions (they never search).
- Searching the user's own chats or files (RAG over local data).

---

## Behavior

### The toggle

- The composer gets a **Web search** toggle button next to **Compare**, styled the same way (`aria-pressed`).
- Tooltip: "Let the model search the web. Each search costs about $0.007 on top of the model's price, even with free models."
- The state is remembered per chat in `localStorage` (key `openchat.search.<chatId>`, value `"1"` or `"0"`). A brand-new chat starts with it off; the state carries over when the first send creates the chat, as Compare's does.
- It applies to the next **send** and **edit**. It works in Compare mode (every model in the comparison may search).

### Regenerate and Retry

They reuse the setting saved on the user message being replied to, not the current toggle. Regenerating a searched reply searches again; regenerating a plain one doesn't.

### While a reply streams

The thinking indicator reads `Thinking… Ns · web search on` when search is on for that reply, instead of `Thinking… Ns`.

### After a reply

- If the reply has sources, a **Sources (N)** disclosure appears under the reply (closed by default). Each source is a link showing its title (or the URL when the title is empty) and its domain in muted text, opening in a new tab.
- The meta line shows `· searched N×` after the cost when the reply searched at least once.
- Compare columns show the same Sources disclosure and count for each column.
- A stopped or failed reply keeps whatever sources arrived before it stopped.

### Links in replies

All links in rendered replies open in a new tab (`target="_blank" rel="noopener noreferrer"`). Search-grounded replies are full of links, and today a click navigates away from OpenChat.

### Settings

Settings → Other gets a short note (text only, no setting):

> **Web search** — Searches are run by OpenRouter's search partners (Exa, or the model maker's own search), so your search queries are sent to them. Each search costs about $0.007 on top of the model's price, even with free models.

---

## Data model

```sql
ALTER TABLE messages ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0;  -- user messages: search was on when sent
ALTER TABLE messages ADD COLUMN sources TEXT;                          -- assistant messages: JSON [{ url, title }] or NULL
ALTER TABLE messages ADD COLUMN web_searches INTEGER;                  -- assistant messages: searches run, NULL if unknown/none
ALTER TABLE models ADD COLUMN supports_tools INTEGER;                  -- 1/0, NULL = unknown
```

- All four added through `migrate()` when missing; the `CREATE TABLE` statements get them too.
- `models.supports_tools` is stored by `addModel` from `CatalogModel.supportsTools` and backfilled from the cached catalog the same way as `input_modalities`. Unknown is treated as **no tool support**, which falls back to the plugin (works with every model).

## Shared types

```ts
export interface Source { url: string; title: string }

// Message gains:
webSearch: boolean;           // user messages: whether search was on; false for assistant messages
sources: Source[];            // assistant messages: deduplicated by URL, in arrival order; [] otherwise
webSearches: number | null;   // assistant messages: searches run, when known
```

`LibraryModel` is unchanged (only the server needs tool support).

---

## Server

### Request building

`streamChat` gains `webSearch?: 'tool' | 'plugin'`:

- `'tool'` → adds `tools: [{ type: 'openrouter:web_search', parameters: { max_results: 5 } }]` and `max_tool_calls: 3`.
- `'plugin'` → adds `{ id: 'web', max_results: 5 }` to `plugins`.
- `plugins` merges with the PDF `file-parser` entry when both apply; it is still omitted when empty.

`promptFor` (in `generate.ts`) also returns the search mode: none when the user message being replied to has `web_search = 0`; `'tool'` when the replying model's `supports_tools` is 1; otherwise `'plugin'`. Each comparison slot decides for its own model.

### Stream parsing

`streamChat` yields a new event `{ type: 'sources'; sources: Source[] }` whenever a chunk carries `delta.annotations`. Only `url_citation` entries are kept, as `{ url, title }` (the `content` snippet is dropped). `Usage` gains `webSearches: number | null` from `usage.server_tool_use_details.web_search_requests`.

### Saving

`streamReply` and each comparison slot collect sources (deduplicated by URL, first title wins) and save them with the reply, complete or stopped. `web_searches` is the reported count; for the plugin, 1 when the reply has any sources, otherwise NULL.

### Generation endpoints

- `/messages` and `/edit` accept `webSearch?: boolean` (default false) and store it on the new user message. Any non-boolean value is a 400 "webSearch must be true or false."
- `/regenerate` is unchanged; it uses the stored flag.

### SSE

No new events. Sources reach the client in the saved `Message` (`done`, `slot-done`, and the chat detail). Partial replies carry theirs in `error`/`slot-error` `partial`.

---

## Web

- `lib/search.ts` (new, pure, unit tested): `loadSearch(chatId)`, `saveSearch(chatId, on)` and `domainOf(url)`.
- `Composer.tsx`: renders the toggle from new props `webSearch: boolean` and `onWebSearchChange(on: boolean)`; `onSend(text, attachments)` is unchanged.
- `ChatView.tsx`: holds the per-chat toggle state (saved on change, carried to a newly created chat); sends `webSearch` in send/edit bodies; passes it to the thinking indicator for pending replies (for regenerate, the user message's `webSearch`).
- `components/Sources.tsx` (new): the disclosure; used by `MessageItem` and `CompareColumns`.
- `MessageItem.tsx` / `CompareColumns.tsx`: the `searched N×` meta and `Sources`.
- `ThinkingIndicator.tsx`: optional `webSearch` prop.
- `Markdown.tsx`: links open in a new tab.
- `pages/Settings.tsx`: the note.
- Model Library: the **Tools** chip loses its "Not used by OpenChat yet" marker (web search uses tool support).

## Error handling

| Situation | Result |
|---|---|
| OpenRouter or the search provider fails | Reply error as today, through `friendlyError`; sources received so far are kept on the partial |
| Model claims tool support but rejects the tool | Provider error shown as a reply error; the user can turn search off or pick another model. (No automatic retry with the plugin: it would hide a real problem and double-charge.) |
| `webSearch` not a boolean | 400 |
| Unknown tool support | Plugin is used |

## Testing

- **Server (Vitest, mocked OpenRouter):**
  - `streamChat`: tool mode body has `tools` and `max_tool_calls: 3`; plugin mode adds the `web` plugin; merges with `file-parser`; neither when off. Annotations become `sources` events (non-`url_citation` ignored, `content` dropped); `webSearches` read from usage.
  - `/messages` and `/edit` store `webSearch`; bad values 400; regenerate uses the stored flag even when sent without it.
  - Tool vs plugin choice from `supports_tools` (1, 0, NULL, model not in library).
  - Sources deduplicated and saved on complete and stopped replies; `web_searches` for tool and plugin.
  - Comparison: each slot uses its own model's mode; each reply gets its own sources.
  - Migrations add the four columns to an old database; `supports_tools` stored and backfilled.
  - Plain chats send exactly the same request body as before (no `tools`, no `plugins`).
- **Web:** unit tests for `lib/search.ts`.
- **Manual (browser pane, real key):** toggle on, ask something current with a tool-capable model and see sources and the search count; "say hi" with search on (no search, no sources); regenerate a searched reply; compare two models with search; reload and see sources; a link opens in a new tab; toggle remembered per chat; light and dark.
