# Local Models, Stage 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local models search the web through SearXNG or Tavily, chosen in Settings: models with tools get a `web_search` function (at most 3 searches per reply), models without tools get the user's message searched before they reply, and the results become the reply's sources.

**Architecture:** Search services sit behind a `SearchService` interface in `server/src/webSearch/`, picked from three new settings. `promptFor` stops blanking `webSearch` for local models when a service is set, reusing the existing `'tool' | 'plugin'` modes. `chatProvider`'s local branch wraps the stream in `withLocalSearch`, which runs the tool loop (or the search-before-reply) itself, yields `sources` events and one merged `usage` event, so the routes, Compare and the saved rows need no search-specific changes. Local clients learn to send assistant tool calls and tool results back. The web adds a Web search card in Settings and enables the toggle for local models when search is ready.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-local-models-design.md` (read it first; this plan covers "Build stages" item 3 and the "Web search" section). Stage 1's and 2's plans, `docs/superpowers/plans/2026-10-20-local-models-stage-1.md` and `…-stage-2.md`, describe the provider layer and fake local server this builds on.

## Global Constraints

- OpenRouter models keep OpenRouter's search exactly as today: same request fields, same `SEARCH_TOOLTIP`/`SEARCH_NOTE`, same stored rows. Existing tests keep passing unless a task says otherwise.
- Tests never call a real SearXNG or Tavily: they use `test/fakeSearchServer.ts` (Task 1). Tavily's base address is `https://api.tavily.com`, overridable with `env.OPENCHAT_TAVILY_URL` (tests set it to the fake).
- Limits: at most **3** searches per reply (today's cap); **5** results per search; each result's text cut to **800** characters (ending `…` when cut); the search-before-reply query is the user's message cut to **400** characters; every search request times out after **10,000 ms**. The pre-send overflow check reserves **3,000** tokens (`SEARCH_RESERVE_TOKENS`) for results when a local model will search.
- Settings keys: `web_search_service` (`none` | `searxng` | `tavily`, default `none`), `searxng_url` (default `''`), `tavily_api_key` (default `''`). `tavily_api_key` is masked with `maskKey` in the view and left out of the data export like `api_key`.
- Copy, verbatim (`{host}` is `host:port` as in stage 1's `hostOf`):
  - Composer toggle with no service and only local models chosen: `Set up web search in Settings` (exists). When every chosen model is local and search is ready: `Web search: on. Searches run through SearXNG.` / `… through Tavily.` (`on`/`off` as today). Mixed or OpenRouter-only selections keep today's tooltip.
  - Settings card: heading `Web search`; under it `For local models. OpenRouter models use OpenRouter's own search.`; choice labels `None`, `SearXNG`, `Tavily`; SearXNG address placeholder `http://localhost:8080`, note `Searches go to your SearXNG instance, which asks the search engines it is set up to use.`; Tavily key placeholder `tvly-…`, note `Your search queries are sent to Tavily. The free plan includes 1,000 searches a month.`; key line `Using key {masked}.` / `No key set yet.`; buttons `Save`, `Test connection`, `Remove saved key`; results `Saved.`, `Testing…`, `Connection works.`, `Failed: {error}`.
  - SearXNG unreachable: `Can't reach SearXNG at {host}. Is it running?`
  - SearXNG with JSON off (it answers `format=json` with 403): `SearXNG answered, but its JSON output is turned off. In SearXNG's settings.yml, under "search:", add json to "formats" so it reads "formats: [html, json]", then restart SearXNG.`
  - SearXNG other failure: `SearXNG couldn't search (HTTP {status}).` · timeout: `SearXNG didn't answer within 10 seconds.`
  - Tavily: unreachable `Can't reach Tavily. Check your internet connection.`; 401 `Tavily didn't accept this API key.`; 429 `Tavily is limiting searches right now. Try again in a minute.`; 432 or 433 `Your Tavily plan's search limit is used up.`; other `Tavily couldn't search (HTTP {status}).`; timeout `Tavily didn't answer within 10 seconds.`
  - Test route without a complete setup: `Choose a search service and fill in its details first.`
  - Settings validation (400): `Web search service must be none, searxng, or tavily.` · `SearXNG address must start with http:// or https://.`
  - Search-before-reply failure ends the reply with: `Web search failed: {service error}`
  - Tool result for a failed search: `Search failed: {service error}`; for a search over the cap: `Search limit reached. Answer with what you have.`; for a call with no usable `query`: `The search needs a "query" string.`; for an unknown function: `There is no tool called {name}.`; empty results: `No results.`
- `web_search` function: description `Search the web. Use it for recent events or facts you are not sure of. Returns the top results with their addresses.`; parameters `{ type: 'object', properties: { query: { type: 'string', description: 'What to search for' } }, required: ['query'] }`.
- Results as text (tool result and prompt block), one block per result, separated by a blank line: `[{n}] {title}\n{url}\n{text}`. The search-before-reply block appended to the last user message: `<search_results query="{query}">\n{results}\n</search_results>\nUse these web search results if they help, and mention the sources you use.`
- Never touch the user's `data/openchat.db`, and leave port 5173 to the user's own dev server. Browser checks run a built copy: `npm run build`, then the server with `OPENCHAT_DB=.superpowers/verify/openchat.db` and `OPENCHAT_PORT=3100`, opened at `http://localhost:3100`.
- Commit after every task, ending each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Not in this plan

- Brave Search, Ollama's web search (spec non-goals); search in Discussions (turns never search today).
- Stage 4 (Discussions and Compare scheduling).

## Review Focus

1. **The search service is down while the user has search on.** Tool mode: the model gets `Search failed: Can't reach SearXNG at …` as the tool result and still answers; search-before-reply: the reply ends with `Web search failed: …`, nothing raw (`fetch failed`, `ECONNREFUSED`) reaches the user, and the usage row is logged as an error. Test in Tasks 4 and 5.
2. **A small model that keeps calling the tool** (every round asks for another search, or calls with garbage arguments): the reply still ends, after at most 3 real searches and 4 model rounds, with the last round sent without tools. Test in Task 4.
3. **Search results pushing a long chat past a local model's window** (Ollama would drop the start silently): the overflow question fires when the estimate plus `SEARCH_RESERVE_TOKENS` exceeds the window, and only when search will actually run. Test in Task 5.
4. **Usage across tool rounds:** the saved reply's `promptTokens` is the last round's (the real context size, so the context ring and overflow check aren't doubled), `completionTokens` and `generationMs` are summed, `webSearches` is the number of searches run, and tok/s stays sane. Test in Task 4.
5. **Search turned off or unset after a message asked for it:** regenerating that message on a local model replies without searching, with no error and no `web_search` tool sent. Test in Task 5.

---

### Task 1: Search services and a fake search server

**Files:**
- Create: `server/src/webSearch/types.ts`, `server/src/webSearch/searxng.ts`, `server/src/webSearch/tavily.ts`, `test/fakeSearchServer.ts`
- Modify: `package.json` (script `"fake-search": "tsx test/fakeSearchServer.ts"`)
- Test: `server/test/webSearchServices.test.ts`

**Interfaces:**
- Produces:
  - `interface SearchResult { title: string; url: string; text: string }`
  - `interface SearchService { name: 'SearXNG' | 'Tavily'; search(query: string, signal?: AbortSignal): Promise<SearchResult[]>; test(): Promise<void> }` — both throw `SearchError` (`class SearchError extends ProviderError`, status 502) carrying the Global Constraints copy; at most 5 results, each `text` cut to 800 characters; results without an http(s) `url` are dropped; a missing title becomes `''`.
  - `createSearxng(baseUrl: string, fetchImpl?: typeof fetch): SearchService` — `GET {baseUrl}/search?q=…&format=json`, results from `results[].{title,url,content}`. `test()` runs a search for `openchat` and maps 403 to the JSON-off copy.
  - `createTavily(apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch): SearchService` — `POST {baseUrl}/search` with `Authorization: Bearer {key}` and `{ query, max_results: 5, search_depth: 'basic' }`, results from `results[].{title,url,content}`. `test()` calls `GET {baseUrl}/usage` (confirm against docs.tavily.com; if that endpoint doesn't exist, a 1-result search) so the test costs no search when possible.
  - Fake: `startFakeSearchServer(o?: { port?: number; json?: boolean; tavilyKey?: string }): Promise<FakeSearch>` with `url`, `requests: { method; path; query; body; auth }[]`, `setResults(r: { title: string; url: string; content: string }[])` (default three fixed results), `setJson(on: boolean)`, `failNext(status: number)`, `hang(on: boolean)`, `close()`. It answers SearXNG's `GET /search` (403 HTML when `format=json` and JSON is off) and Tavily's `POST /search` and `GET /usage` (401 when the bearer key isn't `tavilyKey`, default `tvly-test`). Run as a script: `npm run fake-search -- --port 8888` (flags `--no-json`, `--tavily-key <key>`).

- [ ] **Step 1: Write the failing tests** against the fake:
  - SearXNG: `search('cats')` returns the fake's results with `content` as `text`, and sent `q=cats&format=json`; 7 results → 5; a 2,000-character `content` → 800 characters ending `…`; a `javascript:` url is dropped. JSON off → `search` and `test` reject with the JSON-off copy. Closed server → `Can't reach SearXNG at 127.0.0.1:{port}. Is it running?`. `hang(true)` with a 200 ms timeout override (export the timeout as an option for tests) → the timeout copy.
  - Tavily: `search` sends the bearer key and `max_results: 5`; wrong key → `Tavily didn't accept this API key.`; `failNext(429)`, `failNext(432)`, `failNext(500)` → their copy; `test()` hits `/usage` and not `/search`.
- [ ] **Step 2: Run** `npx vitest run server/test/webSearchServices.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same test, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): SearXNG and Tavily search services`

---

### Task 2: Web search settings and the connection test

**Files:**
- Create: `server/src/webSearch/index.ts`
- Modify: `server/src/settings.ts`, `server/src/routes/settings.ts`, `server/src/exportData.ts`, `shared/types.ts`
- Test: `server/test/settings.test.ts`, `server/test/settingsRoutes.test.ts`, `server/test/export.test.ts`

**Interfaces:**
- Consumes: `createSearxng`, `createTavily`, `SearchService` (Task 1).
- Produces:
  - `type SearchServiceId = 'none' | 'searxng' | 'tavily'` in `shared/types.ts`.
  - `SettingsView` gains `searchService: SearchServiceId; searxngUrl: string; hasTavilyKey: boolean; tavilyKeyMasked: string; searchReady: boolean`. `SettingsUpdate` gains `searchService`, `searxngUrl`, `tavilyKey`.
  - `updateSettings` validates `searchService` and `searxngUrl` (trimmed, trailing `/` removed, `''` allowed), trims `tavilyKey`.
  - `webSearchService(db: DB, env: Env, fetchImpl?: typeof fetch): SearchService | null` in `webSearch/index.ts` — `null` for `none`, SearXNG without an address, or Tavily without a key; Tavily uses `env.OPENCHAT_TAVILY_URL ?? 'https://api.tavily.com'`. `searchReady` is `webSearchService(...) !== null`.
  - `POST /api/settings/test-search` → `{ ok: true }` or `{ ok: false, error }` for the saved setup (the "fill in its details" copy when not ready).
  - The export's settings query leaves out `api_key` and `tavily_api_key`.

- [ ] **Step 1: Write the failing tests:** defaults read `searchService: 'none'`, `searchReady: false`; saving Tavily with `tavilyKey: ' tvly-abcdefghijkl '` → `hasTavilyKey: true`, `tavilyKeyMasked: 'tvly-a…ijkl'`, and the view never contains the key; `searxngUrl: 'ftp://x'` → 400 with the copy; `'http://localhost:8080/'` stores `http://localhost:8080`; `searchService: 'brave'` → 400; `test-search` with the fake SearXNG works, with JSON off returns the JSON-off copy, with `none` returns the details copy; an export contains `web_search_service` but no `tavily_api_key`.
- [ ] **Step 2: Run** `npx vitest run server/test/settings.test.ts server/test/settingsRoutes.test.ts server/test/export.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): web search settings with a connection test`

---

### Task 3: Tool calls and tool results for local clients

**Files:**
- Modify: `server/src/prompt.ts` (`ChatMessage`), `server/src/providers/ollama.ts`, `server/src/providers/openaiCompat.ts`
- Test: `server/test/ollamaClient.test.ts`, `server/test/lmstudioClient.test.ts`

**Interfaces:**
- Produces:
  - `interface ToolCall { id: string; name: string; arguments: string }` in `prompt.ts`; `ChatMessage.role` gains `'tool'`; `ChatMessage` gains `toolCalls?: ToolCall[]` (assistant) and `toolCallId?: string; toolName?: string` (tool). Nothing in OpenRouter's path ever sets them.
  - Ollama: an assistant message with `toolCalls` goes as `tool_calls: [{ function: { name, arguments: <parsed JSON object, {} if it doesn't parse> } }]`; a tool message as `{ role: 'tool', content, tool_name }`.
  - OpenAI-compatible (LM Studio and others): assistant → `tool_calls: [{ id, type: 'function', function: { name, arguments } }]`; tool → `{ role: 'tool', tool_call_id, content }`.

- [ ] **Step 1: Write the failing tests:** a `streamChat` whose messages end with an assistant tool call `{ id: 'call_1', name: 'web_search', arguments: '{"query":"cats"}' }` and a tool result reaches the fake Ollama with `tool_calls[0].function.arguments` equal to `{ query: 'cats' }` and the tool message's `tool_name: 'web_search'`; the same through LM Studio reaches it with `tool_call_id: 'call_1'` and the arguments as a string; arguments `'not json'` reach Ollama as `{}`.
- [ ] **Step 2: Run** `npx vitest run server/test/ollamaClient.test.ts server/test/lmstudioClient.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): local clients send tool calls and results back`

---

### Task 4: The local search loop

**Files:**
- Create: `server/src/providers/localSearch.ts`
- Test: `server/test/localSearch.test.ts`

**Interfaces:**
- Consumes: `SearchService`, `SearchResult` (Task 1); `ChatMessage`, `ToolCall` (Task 3); `ChatRequest`, `StreamEvent`, `WebSearchMode`.
- Produces:
  - `const WEB_SEARCH_TOOL: FunctionTool` and `formatResults(results: SearchResult[]): string` (Global Constraints copy; `No results.` when empty).
  - `withLocalSearch(run: (req: ChatRequest) => AsyncGenerator<StreamEvent>, req: ChatRequest & { webSearch: WebSearchMode }, service: SearchService): AsyncGenerator<StreamEvent>`.
  - `'plugin'` (search before reply): takes the last user message's text (string content, or its `text` parts joined), cut to 400 characters; when empty, runs `run(req)` unchanged. Otherwise searches (failure → throws `ProviderError('Web search failed: …', 502)` before calling the model), yields `{ type: 'sources' }` for the results, appends the results block as a text part to that user message, and streams `run(…)` with no tools.
  - `'tool'`: up to 4 rounds. Each round calls `run` with `tools: [WEB_SEARCH_TOOL]` while fewer than 3 searches have run, and with no tools on the last allowed round or once 3 searches ran. `delta`, `reasoning` and `status` events pass through; `tool_call` and `usage` events are held. A round with no tool calls ends the loop. Otherwise the round's text and calls (ids `call_{n}`, counting across the reply) become an assistant message, then one tool message per call (Global Constraints copy for cap, bad query, unknown name, failure), searches run in order; each successful search yields `sources` right away.
  - Usage: one `usage` event at the end — `promptTokens` of the last round, `completionTokens`, `reasoningTokens` and `generationMs` summed over rounds that report them (`null` when none do), `loadMs` of the first round, `cost: 0`, `webSearches` the number of searches that ran (failed ones count; cap and bad-query refusals don't). In `'plugin'` mode `webSearches` is 1.
  - Abort: `req.signal` goes to every search; an aborted search rethrows the `AbortError`.

- [ ] **Step 1: Write the failing tests** with a scripted `run` (records each request, yields given events) and a stub `SearchService`:
  - Tool mode: round 1 calls `web_search {"query":"cats"}`, round 2 answers → events are `sources`, the round-2 deltas, one `usage`; round 2's request has an assistant message with `toolCalls[0].id === 'call_1'` and a tool message with `formatResults` text; `usage.webSearches === 1`.
  - Review Focus 2: a model that calls the tool every round → exactly 3 searches, 4 rounds, the 4th request has no `tools`; a model that calls with `{}` every round → 0 searches, 4 rounds, ends; two calls in one round count as two searches.
  - Review Focus 1 (tool mode): the service throws `SearchError("Can't reach SearXNG at localhost:8080. Is it running?")` → the tool message reads `Search failed: Can't reach SearXNG…` and the reply still streams round 2.
  - Review Focus 4: rounds reporting `promptTokens` 100 and 300, `completionTokens` 20 and 50, `generationMs` 200 and 500 → merged `{ promptTokens: 300, completionTokens: 70, generationMs: 700, loadMs: <round 1's> }`.
  - Plugin mode: the user message `What's new in Node 24?` is searched as is, the request's last user message ends with the results block, no `tools` are sent, `sources` comes before the first delta; a 1,000-character message is searched as its first 400 characters; a failing service throws `Web search failed: …` and `run` is never called; an attachment-only message (empty text) streams without searching.
- [ ] **Step 2: Run** `npx vitest run server/test/localSearch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): web search loop for local models`

---

### Task 5: Local models search in chat and Compare

**Files:**
- Modify: `server/src/generate.ts` (`promptFor`), `server/src/providers/index.ts` (`chatProvider`), `server/src/contextCheck.ts`, `server/src/routes/generate.ts`
- Test: `server/test/localWebSearch.test.ts` (new), `server/test/contextCheck.test.ts`

**Interfaces:**
- Consumes: `webSearchService` (Task 2), `withLocalSearch` (Task 4).
- Produces:
  - `promptFor`: for a local model, `webSearch` is `modelSupportsTools ? 'tool' : 'plugin'` when the message asked for search **and** `webSearchService(db, env)` is not `null`; otherwise `undefined` (replaces the stage 1 comment). OpenRouter models unchanged.
  - `chatProvider`'s local `streamChat`: when `o.webSearch` is set and a service exists, `withLocalSearch((req) => withLoadingStatus(client.streamChat({ ...req, model, contextWindow }), …), o, service)`; else as today. A service removed between prompt and stream means no search.
  - `contextOverflow` takes `webSearch?: boolean`; when true and search is ready, a local model's estimate adds `SEARCH_RESERVE_TOKENS = 3_000` (exported from `contextCheck.ts`). The send and edit routes pass the body's flag; regenerate passes the answered message's `webSearch`.
- Nothing else changes: `searchCount`, `recordUsage`, `insertMessage` and the SSE frames already carry `sources` and `webSearches`.

- [ ] **Step 1: Write the failing tests** with the fake Ollama (`qwen3:1.7b` tools, `gemma3:1b` no tools) and the fake search server set as SearXNG:
  - Send to `qwen3:1.7b` with `webSearch: true`, the fake replying first with a `web_search` tool call then text → the saved reply has the fake's three results as `sources`, `webSearches: 1`, and its text; the fake's second chat request contains a `tool` message; the usage row has `web_search = 1`, `web_searches = 1`.
  - Send to `gemma3:1b` with search → the fake search got the user's text as `q`; Ollama's request carries the results block and no `tools`; the reply has sources and `webSearches: 1`.
  - Compare between `qwen3:1.7b` and `gemma3:1b` with search → both slots' messages have sources.
  - Review Focus 1: search-before-reply with the search server closed → `error` frame `Web search failed: Can't reach SearXNG at 127.0.0.1:{port}. Is it running?`, no raw text, the usage row's status is `error`.
  - Review Focus 5: with `web_search_service` set back to `none`, regenerating the earlier search message on `qwen3:1.7b` replies without `tools` and without sources; with no service at all, a send with `webSearch: true` to a local model replies normally (not an error).
  - OpenRouter unchanged: a scripted `deps.openrouter.streamChat` still receives `webSearch: 'tool'` / `'plugin'` as before and never sees `WEB_SEARCH_TOOL`.
  - `contextCheck.test.ts` (Review Focus 3): a chat estimated at window − 2,000 tokens → no overflow without search, overflow with `webSearch: true` and SearXNG set, no overflow with `webSearch: true` and service `none`.
- [ ] **Step 2: Run** `npx vitest run server/test/localWebSearch.test.ts server/test/contextCheck.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): local models search the web`

---

### Task 6: Web search in Settings and the composer (web)

**Files:**
- Create: `web/src/pages/settings/WebSearchCard.tsx`
- Modify: `web/src/pages/settings/GeneralTab.tsx` (card after `LocalServersCard`), `web/src/api.ts` (`testSearch()`), `web/src/lib/localModels.ts` + test, `web/src/lib/search.ts` + test, `web/src/components/Composer.tsx`, `web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `SettingsView` search fields and `POST /api/settings/test-search` (Task 2).
- Produces:
  - `searchAllowed(models: LibraryModel[], chosenIds: string[], searchReady: boolean): boolean` — true when nothing is chosen, any chosen model isn't local, or `searchReady`.
  - `searchTooltip(o: { on: boolean; allLocal: boolean; service: SearchServiceId; ready: boolean }): string` in `lib/search.ts` — `Set up web search in Settings` when all local and not ready; the `Searches run through …` copy when all local and ready; today's `Web search: on|off. ${SEARCH_TOOLTIP}` otherwise.
  - `Composer` takes `searchService: SearchServiceId` and `searchReady: boolean` (from `ChatView`'s `settings`, `'none'`/`false` while it loads); `ChatView` passes `settings?.searchReady ?? false` to both `searchAllowed` calls.
  - `WebSearchCard({ view, update })`: a `None` / `SearXNG` / `Tavily` choice saved on change; the SearXNG address field (Save) or the Tavily key field (password input, Save, `Remove saved key`, masked key line); `Test connection` enabled when `view.searchReady`; copy from Global Constraints. The old `SEARCH_NOTE` paragraph in "Other" stays (it describes OpenRouter's search).

- [ ] **Step 1: Write the failing tests:** `searchAllowed` with only local models is `false` when not ready and `true` when ready; mixed stays `true`. `searchTooltip` for all four cases, including `Web search: off. Searches run through Tavily.`
- [ ] **Step 2: Run** `npx vitest run web/src/lib/localModels.test.ts web/src/lib/search.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, styling the card like `LocalServersCard`.
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS. (Browser check moves to Task 7.)
- [ ] **Step 5: Commit** `feat(web): choose a web search service for local models`

---

### Task 7: Stage check

**Files:** none (verification only; fixes go in commits of their own)

- [ ] **Step 1:** Run `npm test` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 2:** Serve the built copy as in Global Constraints with `npm run fake-search -- --port 8888` running, in the browser pane:
  - Settings → Web search: choose SearXNG, save `http://localhost:8888`, Test connection → `Connection works.`; restart the fake with JSON off (`--no-json`) → the JSON-off copy. Choose Tavily, save `tvly-test`: the key shows masked; with `OPENCHAT_TAVILY_URL=http://localhost:8888` set on the server, Test connection works.
  - With service `None` and a local model chosen, the search toggle is disabled with `Set up web search in Settings`.
- [ ] **Step 3:** Against the user's real Ollama (`qwen3:1.7b`, `gemma3:1b`) and the search service the user chose for the check (the fake by default; a real SearXNG or Tavily only if the user says so): ask `qwen3:1.7b` something recent with search on → it calls `web_search`, the reply shows sources; ask `gemma3:1b` the same → search-before-reply, sources shown. Note whether `qwen3:1.7b` actually calls the tool and how its thinking looks across rounds. Screenshots go to the user.
- [ ] **Step 4:** Fix what the check finds, each with a failing test against the fakes first where possible, and commit.
