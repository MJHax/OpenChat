# Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let replies search the web through OpenRouter (server tool for tool-capable models, `web` plugin otherwise), toggled per message in the composer, with sources saved and shown under each reply.

**Architecture:** The user message stores whether search was on; the prompt helper turns that plus the replying model's tool support into a search mode; `streamChat` adds the tool or plugin and turns streamed `url_citation` annotations into `sources` events; replies save deduplicated sources and the search count. The web client keeps a per-chat toggle in `localStorage`, sends `webSearch`, and renders a Sources disclosure.

**Tech Stack:** TypeScript, Hono 4, better-sqlite3, React 19 + Vite, Vitest (`*.test.ts`, logic only — no component tests).

**Spec:** `docs/superpowers/specs/2026-10-16-web-search-design.md`

## Global Constraints

- Tool mode body: `tools: [{ type: 'openrouter:web_search', parameters: { max_results: 5 } }]`, `max_tool_calls: 3`. Plugin mode: `{ id: 'web', max_results: 5 }` in `plugins`. `engine` is never set.
- `plugins` merges with the PDF `file-parser` entry and is omitted when empty. A request without search must have neither `tools` nor `max_tool_calls`, and its body must be unchanged from today.
- Unknown tool support (`supports_tools` NULL or model not in the library) → plugin mode.
- Regenerate/Retry use the `web_search` flag stored on the user message; send/edit use the toggle.
- Sources are `{ url, title }`, deduplicated by URL (first title wins), in arrival order; only `url_citation` annotations with `http:`/`https:` URLs are kept; the `content` snippet is never stored.
- `web_searches`: the tool's reported `server_tool_use_details.web_search_requests`; for plugin mode, 1 when the reply has sources, else NULL.
- Copy (exact):
  - Toggle label `Web search`; tooltip `Let the model search the web. Each search costs about $0.007–$0.01 on top of the model's price, even with free models.`
  - Thinking indicator: `Thinking… Ns · web search on`
  - Disclosure summary: `Sources (N)`; meta: `· searched N×`
  - Bad body value: `webSearch must be true or false.`
  - Settings note: `Web search — Searches are run by OpenRouter's search partners (Exa, or the model maker's own search), so your search queries are sent to them. Each search costs about $0.007–$0.01 on top of the model's price, even with free models.`
- `localStorage` key `openchat.search.<chatId>`, values `"1"`/`"0"`; every access wrapped in try/catch.
- Keep each file's existing line endings (the repo mixes CRLF and LF per file); new files LF.
- Work on branch `feat/web-search`.
- Verify every task with `npx tsc --noEmit` and `npx vitest run --dir server` / `--dir web/src` (plain `npm test` also collects an old worktree under `.claude/worktrees`).

## Review Focus

- **A hostile or odd source URL** (`javascript:alert(1)`, `data:…`, a relative path) must never become a link. Pinned in Task 2 (`toSources` drops non-http(s) URLs).
- **A source with an empty title** must still be readable: it shows its URL. Pinned in Task 4 (`sourceLabel`).
- **Messages saved before this feature** (columns NULL/0) must load as `webSearch: false`, `sources: []`, `webSearches: null`, and regenerating them must not search. Pinned in Task 1 and Task 3.
- **Search on, a PDF attached, and a model without tool support** must send one `plugins` array with both entries. Pinned in Task 2.
- **`localStorage` throwing** (private window) must leave the toggle working, just not remembered. Pinned in Task 4.

---

## File Structure

| file | change | responsibility |
|---|---|---|
| `shared/types.ts` | modify | `Source`; `Message.webSearch`, `sources`, `webSearches` |
| `server/src/db.ts` | modify | four columns + migrations |
| `server/src/catalog.ts` | modify | `cachedCapabilities` replaces `cachedModalities` |
| `server/src/library.ts` | modify | store/backfill `supports_tools`; `modelSupportsTools` |
| `server/src/messages.ts` | modify | read/write the new message fields |
| `server/src/openrouter.ts` | modify | search modes in the body; `sources` events; `Usage.webSearches`; `toSources` |
| `server/src/generate.ts`, `server/src/compare.ts` | modify | search mode in `promptFor`; collect and save sources |
| `server/src/routes/generate.ts` | modify | `webSearch` on `/messages` and `/edit` |
| `web/src/lib/search.ts` (+ test) | create | toggle storage, `domainOf`, `sourceLabel` |
| `web/src/components/Sources.tsx` | create | the disclosure |
| `web/src/components/{Composer,ChatView,MessageItem,CompareColumns,ThinkingIndicator,Markdown}.tsx`, `web/src/pages/Settings.tsx`, `web/src/lib/catalog.ts`, `web/src/styles.css` | modify | UI wiring |

---

### Task 1: Storage for search flags, sources and tool support

**Files:**
- Modify: `shared/types.ts`, `server/src/db.ts`, `server/src/catalog.ts`, `server/src/library.ts`, `server/src/messages.ts`
- Test: `server/test/db.test.ts`, `server/test/models.test.ts`; fix `Message` fixtures the typecheck flags (`server/test/tree.test.ts`, web tests)

**Interfaces:**
- Produces:
  - `interface Source { url: string; title: string }`; `Message` gains `webSearch: boolean`, `sources: Source[]`, `webSearches: number | null`
  - `NewMessage` gains optional `webSearch?: boolean`, `sources?: Source[]`, `webSearches?: number | null`
  - `cachedCapabilities(db: DB): Map<string, { inputModalities: string[]; supportsTools: boolean }>` (empty for no cache or a legacy cache) — `backfillModalities` switches to it
  - `modelSupportsTools(db: DB, id: string): boolean` — false when not in the library or unknown

- [ ] **Step 1: Write the failing tests**
  - `db.test.ts` `'stores the search flag and sources on messages'`: insert a user message with `webSearch: true` and an assistant message with `sources: [{ url: 'https://a.example', title: 'A' }]`, `webSearches: 2`; read back via `getChatMessages` and `getMessage`. A plain message reads `webSearch: false`, `sources: []`, `webSearches: null`.
  - `db.test.ts` `'adds the web search columns to old databases'`: like the existing `input_modalities` migration test, an old `messages` and `models` table gains `web_search`, `sources`, `web_searches` and `supports_tools`; an old row reads with the defaults above.
  - `models.test.ts`: `addModel` stores `supportsTools` (catalog fixture `google/gemini` gets `supportsTools: true`) → `modelSupportsTools(db, 'google/gemini')` true; after `UPDATE models SET supports_tools = NULL` it is backfilled from the cache; with no cache row and NULL → false; unknown id → false.
- [ ] **Step 2: Run** `npx vitest run --dir server db.test.ts models.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Columns exactly as in the spec's Data model (`web_search INTEGER NOT NULL DEFAULT 0`, `sources TEXT`, `web_searches INTEGER`, `supports_tools INTEGER`) in `CREATE TABLE` and `migrate()`. `sources` stored as JSON, NULL when empty.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run --dir server && npx vitest run --dir web/src` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): store web search flags, sources and tool support`

### Task 2: OpenRouter request and stream handling

**Files:**
- Modify: `server/src/openrouter.ts`
- Test: `server/test/openrouter.test.ts`

**Interfaces:**
- Consumes: `Source` (Task 1), `Plugin` from `prompt.ts`.
- Produces:
  - `type WebSearchMode = 'tool' | 'plugin'`
  - `streamChat(o: { …; webSearch?: WebSearchMode })`
  - `StreamEvent` gains `{ type: 'sources'; sources: Source[] }`; `Usage` gains `webSearches: number | null`
  - `toSources(annotations: unknown): Source[]` (exported for tests)

- [ ] **Step 1: Write the failing tests**
  - Body: `webSearch: 'tool'` → `tools` and `max_tool_calls: 3` exactly as Global Constraints, no `plugins`; `'plugin'` → `plugins: [{ id: 'web', max_results: 5 }]`; `'plugin'` plus `plugins: [file-parser cloudflare-ai]` → one array with both (file-parser first); no `webSearch` → body has no `tools`, `max_tool_calls` or `plugins` keys.
  - Stream: a chunk with `delta.annotations` (two `url_citation`s and one `{ type: 'file' }`) yields one `sources` event with two `{ url, title }` entries and no `content`.
  - `toSources`: drops `javascript:alert(1)`, `data:text/html,x` and `/relative`; keeps `http://` and `https://`; missing title → `''`; non-array → `[]`.
  - Usage: `server_tool_use_details.web_search_requests: 2` → `webSearches: 2`; absent → `null`.
- [ ] **Step 2: Run** `npx vitest run --dir server openrouter.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** URL check with `new URL(url).protocol` inside try/catch.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run --dir server` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): web search modes and sources in the OpenRouter client`

### Task 3: Generation with web search

**Files:**
- Modify: `server/src/generate.ts`, `server/src/compare.ts`, `server/src/routes/generate.ts`
- Test: `server/test/generate.test.ts`, `server/test/compare.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `promptFor(...)` returns `{ messages: ChatMessage[]; plugins?: Plugin[]; webSearch?: WebSearchMode }` — mode from the parent user message's `webSearch` and `modelSupportsTools`
  - `mergeSources(existing: Source[], incoming: Source[]): Source[]` in `generate.ts` (dedupe by URL, first title wins)
  - `/messages` and `/edit` accept `webSearch?: boolean`

- [ ] **Step 1: Write the failing tests** (extend the `scripted`/`byModel` fakes to record the `webSearch` argument and to yield `sources` events):
  - Send with `webSearch: true` → user message saved with `webSearch: true`; a library model with `supportsTools: true` gets mode `'tool'`; one with `false`, a NULL row and an unknown model get `'plugin'`.
  - Send without `webSearch` → no mode passed. `webSearch: 'yes'` on `/messages` and `/edit` → 400 `webSearch must be true or false.`
  - Sources from two events with a duplicate URL are saved once, in order, on the `done` message and in the DB; `webSearches` from usage (tool) or 1 (plugin with sources) or null (plugin without).
  - A reply that fails after a `sources` event saves a stopped partial with those sources.
  - Regenerate a reply to a searched user message → mode passed even though the request has no `webSearch`; regenerate one saved before the feature (flag 0) → no mode.
  - `/edit` with `webSearch: true` stores it on the new version.
  - Comparison of a tool model and a non-tool model with search on → `'tool'` and `'plugin'` respectively; each reply saves its own sources.
  - `mergeSources` unit test.
- [ ] **Step 2: Run** `npx vitest run --dir server generate.test.ts compare.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Validate `webSearch` before `claim(chat)`. Pass `webSearch` into `saveUserMessage`/`insertMessage`. In `streamReply` and `runSlot`, accumulate with `mergeSources` and pass `sources`/`webSearches` to `save`.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run --dir server` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): replies search the web when asked and save their sources`

### Task 4: Web helpers

**Files:**
- Create: `web/src/lib/search.ts`, `web/src/lib/search.test.ts`
- Modify: `web/src/lib/catalog.ts`, `web/src/lib/catalog.test.ts`

**Interfaces:**
- Produces: `loadSearch(chatId: string): boolean`, `saveSearch(chatId: string, on: boolean): void`, `domainOf(url: string): string` (hostname without `www.`, or the input when unparseable), `sourceLabel(s: Source): string` (title trimmed, or the URL when empty).

- [ ] **Step 1: Write the failing tests:** save then load round-trips per chat id; a missing key → false; with `localStorage.getItem`/`setItem` stubbed to throw (assign a throwing object to `globalThis.localStorage` in the test), `loadSearch` → false and `saveSearch` doesn't throw; `domainOf('https://www.nodejs.org/en/blog')` → `'nodejs.org'`; `sourceLabel({ url: 'https://x.dev/a', title: '  ' })` → `'https://x.dev/a'`. In `catalog.test.ts` change the CAPABILITIES test to expect `tools: true`.
- [ ] **Step 2: Run** `npx vitest run --dir web/src search.test.ts catalog.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; set `usedByOpenChat: true` for `tools`.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run --dir web/src` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): web search helpers; Tools capability now used`

### Task 5: Web search UI

**Files:**
- Create: `web/src/components/Sources.tsx`
- Modify: `web/src/components/Composer.tsx`, `ChatView.tsx`, `MessageItem.tsx`, `CompareColumns.tsx`, `ThinkingIndicator.tsx`, `Markdown.tsx`, `web/src/pages/Settings.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: Task 4; `Message.sources`, `webSearches`, `webSearch`.
- Produces: `Sources({ sources: Source[] })` (renders nothing when empty); `ThinkingIndicator` optional `webSearch?: boolean`; Composer props `webSearch: boolean`, `onWebSearchChange(on: boolean): void`; ChatView `Pending` gains `webSearch: boolean`.

- [ ] **Step 1: Build it.**
  - Composer: `Web search` toggle (`className="toggle"`, `aria-pressed`) left of Compare, tooltip from Global Constraints.
  - ChatView: state from `loadSearch(chatId)` on chat change (off without a chat); `saveSearch` on change and onto a newly created chat (next to `saveCompare`); `webSearch` in send/edit bodies; `Pending.webSearch` = the toggle for send/edit, the replied-to user message's `webSearch` for regenerate/retry; passed to both `ThinkingIndicator` uses (also via `Column` in `CompareColumns`).
  - `Sources`: `<details className="sources"><summary>Sources (N)</summary>` list of `<a target="_blank" rel="noopener noreferrer">{sourceLabel}</a> <span className="muted">{domainOf}</span>`.
  - `MessageItem` and `CompareColumns`: `· searched N×` after the cost when `webSearches` ≥ 1, and `<Sources>` under the body.
  - `Markdown`: `components.a` renders `target="_blank" rel="noopener noreferrer"`.
  - Settings → Other: the note (bold "Web search" lead-in).
- [ ] **Step 2: Run** `npx tsc --noEmit && npx vitest run --dir web/src && npx vitest run --dir server` — Expected: PASS.
- [ ] **Step 3: Verify in the browser pane** (`preview_start` `openchat`, real key, cheap tool-capable model such as DeepSeek V4.1 Flash): toggle on and ask something current → sources and `searched N×`, cost higher than a plain reply; "say hi" with search on → no sources, no count; regenerate a searched reply → searches again; compare DeepSeek and Ling with search on; reload → sources still there; a source and an in-reply link open in a new tab; toggle remembered per chat and off in a new chat; light and dark; console clean. Delete the test chat afterwards.
- [ ] **Step 4: Commit** — `feat(web): web search toggle and sources`
