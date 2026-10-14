# OpenChat — Design Spec

**Date:** 2026-10-14
**Status:** Approved (pending spec review)

## Purpose

A locally hosted, single-user web chat interface modeled on Claude.ai, backed by OpenRouter so the user can add any OpenRouter model to a personal library and chat with, switch between, and compare models. Casual personal use; runs only on localhost.

## Scope

### In v1
- Streaming chat with markdown + syntax-highlighted code rendering
- Sidebar chat history (date-grouped), rename/delete, full-text search across all messages
- Model Library: browse/search OpenRouter catalog, add/remove/rename models, set a default
- Mid-chat model switching; each assistant message labeled with its model
- Regenerate any assistant response with any library model; all versions kept with `< n/m >` navigation
- Edit-and-resend user messages, creating a branch with `< n/m >` navigation
- Per-response token count and cost; running per-chat cost total
- Personalization: About me, Custom instructions, manual Memory facts (each toggleable)
- Auto-generated chat titles
- Light / dark / system theme

### Out of scope (v1)
- Attachments / images / files
- Per-chat model parameters (temperature, max tokens)
- Automatic memory extraction
- Multi-user, auth, remote hosting
- Side-by-side model comparison view

## Architecture

```
browser (React SPA)  ⇄  Node server (localhost:3000)  ⇄  OpenRouter API
                              │
                          data/openchat.db (SQLite)
```

- **Backend:** Node 24, TypeScript, Hono (HTTP + streaming), `better-sqlite3`.
- **Frontend:** React + Vite + TypeScript, `react-markdown` + `remark-gfm`, a syntax highlighter (e.g. `shiki` or `highlight.js`), plain CSS with CSS variables for theming.
- **Dev:** single `npm run dev` runs server and Vite concurrently (Vite proxies `/api` to the server).
- **Prod/local use:** `npm start` builds the frontend and serves it from the Node server at `http://localhost:3000`, bound to `127.0.0.1` only.
- **API key:** stored server-side only — read from `.env` (`OPENROUTER_API_KEY`) or set via Settings (stored in the `settings` table). The Settings value takes precedence if set. Never sent to the browser (masked display only).

### Server modules (one clear purpose each)
- `db` — schema creation/migrations and query helpers
- `openrouter` — client: list models, streaming chat completion, non-streaming completion (titles); normalizes errors
- `tree` — pure functions over the message tree: active path, siblings, selecting a branch
- `prompt` — pure function building the outgoing message array (system prompt + active path)
- `routes/*` — chats, messages, models, settings, memory, search

## Data Model (SQLite)

```
settings(key TEXT PK, value TEXT)
  -- api_key, about_me, custom_instructions, theme, default_model_id, title_model_id

models(id TEXT PK,                -- OpenRouter id, e.g. "anthropic/claude-sonnet-4.5"
       display_name TEXT,
       context_length INTEGER,
       prompt_price REAL,          -- USD per token
       completion_price REAL,
       added_at INTEGER)

memories(id INTEGER PK, content TEXT, enabled INTEGER DEFAULT 1, created_at INTEGER)

chats(id TEXT PK, title TEXT, created_at INTEGER, updated_at INTEGER,
      active_leaf_id TEXT)         -- tip of the currently displayed path

messages(id TEXT PK, chat_id TEXT FK, parent_id TEXT NULL,
         role TEXT,                -- 'user' | 'assistant'
         content TEXT,
         model_id TEXT NULL,       -- assistant only
         prompt_tokens INTEGER NULL, completion_tokens INTEGER NULL,
         cost REAL NULL,           -- USD, as reported by OpenRouter
         status TEXT,              -- 'complete' | 'stopped'
         created_at INTEGER)

messages_fts  -- FTS5 virtual table over messages.content (+ chat_id), kept in sync via triggers

model_catalog_cache(fetched_at INTEGER, json TEXT)   -- OpenRouter /models response, 24h TTL
```

### Message tree semantics
- A chat is a tree of messages via `parent_id`. Root user messages have `parent_id = NULL`.
- **Siblings** = messages sharing the same `parent_id` (and chat). Ordered by `created_at`.
- **Regenerate** an assistant message → new assistant sibling (same parent) using the chosen model.
- **Edit** a user message → new user sibling (same parent) with edited content, then a new assistant reply is generated under it.
- **Active path** = walk from `chats.active_leaf_id` up via `parent_id` to the root, reversed.
- **Switching version** (clicking `<` / `>`) on a message at some depth → select that sibling, then descend to its most recently created leaf (follow the newest child at each level); set that as `active_leaf_id`.
- New messages always attach to the current `active_leaf_id`, and the new leaf becomes active.

## Prompt Construction

System message (omitted entirely if all parts empty), sections included only if non-empty:

```
About the user:
<about_me>

Instructions:
<custom_instructions>

Things to remember about the user:
- <memory 1>
- <memory 2>
```

Only `enabled` memories are included. Followed by the active-path messages (role + content). Messages with status `stopped` are included as-is.

## API (server)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/chats` | list chats (id, title, updated_at, total cost) |
| POST | `/api/chats` | create empty chat |
| GET | `/api/chats/:id` | chat + all messages + active path + sibling info |
| PATCH | `/api/chats/:id` | rename / set `active_leaf_id` |
| DELETE | `/api/chats/:id` | delete chat and its messages |
| POST | `/api/chats/:id/messages` | send user message `{content, parentId, modelId}` → SSE stream |
| POST | `/api/chats/:id/regenerate` | `{messageId, modelId}` → SSE stream |
| POST | `/api/chats/:id/edit` | `{messageId, content, modelId}` → SSE stream |
| GET | `/api/search?q=` | FTS results: chat id/title, snippet, message id |
| GET/POST/PATCH/DELETE | `/api/models` | library CRUD; PATCH sets display name/default |
| GET | `/api/models/catalog` | cached OpenRouter catalog |
| GET/PUT | `/api/settings` | settings (api key masked on read) |
| POST | `/api/settings/test-key` | verify key against OpenRouter |
| GET/POST/PATCH/DELETE | `/api/memories` | memory CRUD + enable toggle |

**Streaming:** server-sent events with event types `start` (new message ids), `delta` (text chunk), `done` (final usage: tokens, cost), `error` (normalized message). Stop = client aborts the fetch; server detects disconnect, aborts the OpenRouter request, and saves partial content with `status = 'stopped'` (if any content was received).

**Usage/cost:** request OpenRouter usage accounting (`usage: { include: true }`) so the final chunk reports tokens and cost; store as given.

**Titles:** after the first assistant reply in a chat completes, server makes a non-streaming call with `title_model_id` (fallback: the model just used) asking for a ≤6-word title; failure leaves title as "New chat".

## UI

### Sidebar (collapsible)
- New chat button; search box (debounced, shows results list with snippets; clicking opens the chat).
- Chats grouped Today / Yesterday / Previous 7 days / Older, sorted by `updated_at`.
- Hover menu: rename (inline), delete (with confirm).
- Footer links: Model Library, Settings.

### Chat view
- Message list rendering the active path. Markdown via react-markdown + GFM; code blocks highlighted with copy button.
- Assistant message footer: model display name · `1,240 tok · $0.0031` · `< 2/3 >` (if siblings) · Copy · Regenerate (dropdown of library models, current model first).
- User message: Edit (inline textarea, Save & send / Cancel) · `< n/m >` if siblings.
- Composer: auto-growing textarea, model picker (library models; defaults to last model used in this chat, else default model), Enter sends, Shift+Enter newline, Stop button while streaming.
- Header: chat title and running total cost.
- Empty state (no models in library or no API key): prompt linking to Settings / Model Library.

### Model Library
- **My models:** list with rename, remove, set default.
- **Browse:** search + provider filter over the catalog; each row shows name, id, context length, $/M input and output tokens, Add button (disabled if already added).

### Settings
- API key (masked, replace, Test connection button).
- About me, Custom instructions (textareas, saved on blur/Save).
- Memory: list with add, inline edit, enable toggle, delete.
- Title model selector; theme selector.

## Error Handling
- OpenRouter errors (401 bad key, 402 insufficient credits, 429 rate limit, 404/400 model unavailable, network) normalized to a friendly message and shown as an inline error bubble with Retry. The failed assistant message is not persisted; the user message is persisted.
- Mid-stream error after partial content: save partial with `status = 'stopped'` and show the error bubble.
- Catalog fetch failure: show error with Retry; fall back to stale cache if present.
- Server binds to `127.0.0.1` only.

## Testing
- **Unit (Vitest):** `tree` (active path, sibling selection, descend-to-newest-leaf), `prompt` (section inclusion, disabled memories excluded), SSE parsing of OpenRouter stream, error normalization.
- **Integration (Vitest, in-memory SQLite, mocked OpenRouter):** send / regenerate / edit flows produce the correct tree and `active_leaf_id`; FTS search returns expected hits; stop saves partial content.
- **Manual:** run the app in the browser pane against a cheap OpenRouter model to verify streaming, branching navigation, cost display, search, and settings.

## Project Layout

```
OpenChat/
  package.json            -- workspaces or single package with scripts
  .env.example
  server/src/{index.ts, db.ts, openrouter.ts, tree.ts, prompt.ts, routes/*.ts}
  server/test/*.test.ts
  web/src/{main.tsx, App.tsx, api.ts, components/*, pages/*, styles/*}
  data/openchat.db        -- gitignored
```
