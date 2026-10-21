# Local Models, Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenChat runs every text mode on local models (Ollama, LM Studio, other OpenAI-compatible servers) with OpenRouter as an optional provider: local servers in Settings, local models in the Model Library, chat replies, thinking, the context-window check before sending, and local-only titling.

**Architecture:** A new provider layer (`server/src/providers/`) sits between every chat call site and the model APIs. `chatProvider(deps, modelId)` returns a `ChatProvider` for either OpenRouter (wrapping the existing `OpenRouterClient` with the resolved key) or a local server (one client per server type). Local servers live in a new `local_servers` table, local models in the existing `models` table under ids of the form `local:<serverId>:<name>`. A fake local server in `test/` speaks the Ollama, LM Studio and OpenAI-compatible protocols over real HTTP for tests and for trying the UI by hand.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-local-models-design.md` (read it first; this plan covers its stage 1).

## Global Constraints

- OpenRouter model ids, stored rows, stats and costs must not change for existing users. Every existing test keeps passing unchanged unless a task says otherwise.
- Local model id format: `local:<serverId>:<name>`, where `<name>` is the server's own model name and may contain `:` and `/`. Only the first two `:` separate parts.
- Default local context window: the smaller of the model's maximum and **16,384** tokens.
- Copy, verbatim:
  - Unreachable server: `Can't reach {server name} at {host:port}. Is it running?`
  - Server error: `{server name} couldn't run this model: {server's message}`
  - No key for an OpenRouter model: `No OpenRouter API key set. Add one in Settings.`
  - Overflow prompt: `This chat is longer than {model names} can remember.` with buttons **Summarize and continue**, **Send anyway**, **Cancel**.
  - Dropped-context note on a reply: `Earlier messages were dropped because the chat is longer than this model's memory.`
  - Key field note: `Optional. Needed for OpenRouter models, images and video.`
  - Title-model note: `Chats that only used local models are titled by their own model, so they never leave your machine.`
  - No models hint: `Add a model in the Model Library to start chatting. You can use an OpenRouter key, or a local server like Ollama or LM Studio.`
  - Images/Video without a key: `Needs an OpenRouter key.` with a link to Settings.
  - Local price label: `Free · local`
- Auto-detection candidates: Ollama `http://localhost:11434`, LM Studio `http://localhost:1234`. Every request to a local server used for listing, pinging or detection times out after **1,500 ms**; chat requests have no timeout (models can take minutes to load) but honor the abort signal.
- OpenRouter-only request fields (cache markers from `withCacheMarkers`, `plugins`, OpenRouter's web search tool, `usage: { include: true }`) are never sent to local servers.
- Commit after every task, ending each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Not in this plan (later stages)

- Load time, tokens/sec, stats page split, spending limits ignoring local models, loading/offline/not-installed badges, local PDF text extraction (stage 2). Until stage 2, a reached spending limit still blocks local sends through the existing `checkSpend`.
- Web search for local models (stage 3). In stage 1, a local model with search turned on replies without searching; the search toggle is disabled for local models with the tooltip `Set up web search in Settings` (Task 13).
- The Discussion moderator note, same-server warning, one-model tip, the overflow check before Discussion turns, and one-at-a-time Compare (stage 4). Discussions and Compare already *work* with local models after Task 6, because they go through the provider layer.

## Review Focus

1. **Model names with `:` and `/`** (`qwen3:1.7b`, `lmstudio-community/Qwen3-8B-GGUF`) must round-trip through ids, query strings and requests to the server. Test in Task 1 and Task 8.
2. **A server that accepts a connection but never answers** must not freeze startup, Settings or the Model Library; it reads as offline after 1,500 ms. Test in Task 7.
3. **Addresses typed loosely** (`localhost:11434`, trailing `/`, trailing `/v1`) normalize to one form, so the same server is never listed twice. Test in Task 1 and Task 7.
4. **Removing the server of the default, title or memory model** clears those settings like `removeModel` does, and chats that used it still load (names fall back to the id). Test in Task 3.
5. **No key, but OpenRouter models still in My models:** sending to one fails with the no-key message, while local models keep working and the app no longer shows a global "add your key" blocker. Test in Task 6 and Task 14.

---

### Task 1: Shared local-model helpers and types

**Files:**
- Create: `shared/localModels.ts`
- Create: `shared/localModels.test.ts`
- Modify: `shared/types.ts` (add types below; extend `LibraryModel`, `Message`, `StreamError`)

**Interfaces:**
- Produces (`shared/localModels.ts`):
  - `type LocalServerType = 'ollama' | 'lmstudio' | 'openai'`
  - `const SERVER_TYPE_NAMES: Record<LocalServerType, string>` = `{ ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI-compatible server' }`
  - `const DETECT_CANDIDATES: { type: 'ollama' | 'lmstudio'; baseUrl: string }[]` = Ollama `http://localhost:11434`, LM Studio `http://localhost:1234`
  - `const DEFAULT_LOCAL_WINDOW = 16_384`
  - `localModelId(serverId: string, name: string): string`
  - `parseLocalModelId(id: string): { serverId: string; name: string } | null`
  - `isLocalModelId(id: string): boolean`
  - `defaultContextWindow(max: number | null): number`
  - `normalizeBaseUrl(input: string): string` — throws `Error('Enter an address like http://localhost:11434.')` for anything that isn't http(s) after normalizing
  - `hostOf(baseUrl: string): string` — `localhost:11434`
- Produces (`shared/types.ts`):
  - `interface LocalServer { id: string; type: LocalServerType; name: string; baseUrl: string; auto: boolean; enabled: boolean }`
  - `interface LocalServerStatus extends LocalServer { online: boolean; modelCount: number | null; error: string | null }`
  - `interface LocalModel { id: string; serverId: string; name: string; sizeBytes: number | null; contextLength: number | null; inputModalities: string[]; supportsTools: boolean; supportsReasoning: boolean; capsKnown: boolean }` (`capsKnown` false for `openai` servers)
  - `interface LocalCatalog { servers: LocalServerStatus[]; models: LocalModel[] }`
  - `interface ContextOverflow { modelId: string; displayName: string; window: number; estimate: number }`
  - `LibraryModel` gains `source: 'openrouter' | 'local'; serverId: string | null; serverName: string | null; contextWindow: number | null; capsKnown: boolean`
  - `Message` gains `contextDropped: boolean`
  - `StreamError` gains `overflow?: ContextOverflow[]`

- [ ] **Step 1: Write the failing tests** in `shared/localModels.test.ts`:

```ts
it('round-trips names with colons and slashes', () => {
  for (const name of ['qwen3:1.7b', 'lmstudio-community/Qwen3-8B-GGUF', 'a:b/c:d']) {
    expect(parseLocalModelId(localModelId('ab12cd34', name))).toEqual({ serverId: 'ab12cd34', name });
  }
});
it('never reads an OpenRouter id as local', () => {
  for (const id of ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct:free', 'local', 'local:', 'local:abc']) {
    expect(parseLocalModelId(id)).toBeNull();
    expect(isLocalModelId(id)).toBe(false);
  }
});
it('defaults the window to the smaller of the max and 16,384', () => {
  expect(defaultContextWindow(40_960)).toBe(16_384);
  expect(defaultContextWindow(8_192)).toBe(8_192);
  expect(defaultContextWindow(null)).toBe(16_384);
});
it('normalizes loosely typed addresses', () => {
  for (const input of ['localhost:11434', 'http://localhost:11434/', 'http://localhost:11434/v1', ' HTTP://localhost:11434/v1/ ']) {
    expect(normalizeBaseUrl(input)).toBe('http://localhost:11434');
  }
  expect(normalizeBaseUrl('https://gpu.lan:8443/')).toBe('https://gpu.lan:8443');
  expect(() => normalizeBaseUrl('ftp://x')).toThrow('Enter an address like http://localhost:11434.');
  expect(() => normalizeBaseUrl('')).toThrow();
  expect(hostOf('http://192.168.1.50:11434')).toBe('192.168.1.50:11434');
});
```

- [ ] **Step 2: Run** `npx vitest run shared/localModels.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `shared/localModels.ts` and the type changes. `normalizeBaseUrl` lowercases only the scheme, adds `http://` when no scheme is given, and strips trailing `/` and a trailing `/v1`. Fix every compile error the new required fields cause (`listLibrary`, `insertMessage`/message row mapping, test fixtures) with the values Tasks 3 and 8 fill properly: for now `source: 'openrouter', serverId: null, serverName: null, contextWindow: null, capsKnown: true`, `contextDropped: false`.
- [ ] **Step 4: Run** `npx vitest run shared/localModels.test.ts` then `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(shared): local model ids, server types and address helpers`

---

### Task 2: Fake local server

**Files:**
- Create: `test/fakeLocalServer.ts`
- Create: `test/fakeLocalServer.test.ts`
- Modify: `package.json` (script `"fake-local": "tsx test/fakeLocalServer.ts"`)

**Interfaces:**
- Produces:

```ts
export interface FakeModel { name: string; sizeBytes?: number; contextLength?: number; tools?: boolean; vision?: boolean; thinking?: boolean; loaded?: boolean }
export interface FakeReply { text?: string[]; thinking?: string[]; toolCalls?: { name: string; arguments: object }[]; delayMs?: number; promptTokens?: number; completionTokens?: number }
export interface FakeServer {
  url: string;                                   // http://127.0.0.1:<port>
  requests: { method: string; path: string; body: any }[];
  reply(r: FakeReply): void;                      // replies for the next chat requests, in order; the last one repeats
  setModels(models: FakeModel[]): void;
  failNext(status: number, error: string): void;  // next chat request answers with this error in the flavor's format
  hang(on: boolean): void;                        // accept requests but never answer (for timeout tests)
  close(): Promise<void>;
}
export function startFakeLocalServer(o: { flavor: 'ollama' | 'lmstudio' | 'openai'; models: FakeModel[]; port?: number }): Promise<FakeServer>
```

- Endpoints per flavor (confirm field names against current Ollama and LM Studio docs while writing it; the shapes below are what the clients in Tasks 4–5 rely on):
  - **ollama:** `GET /api/tags` → `{ models: [{ name, model, size, details }] }`; `POST /api/show` `{ model }` → `{ capabilities: [...'completion', 'tools'?, 'vision'?, 'thinking'?], model_info: { 'general.architecture': 'fake', 'fake.context_length': n } }` or 404 `{ error: "model '<name>' not found" }`; `POST /api/chat` → NDJSON lines `{ message: { role: 'assistant', content, thinking? , tool_calls? }, done: false }` then a final line with `done: true, prompt_eval_count, eval_count, load_duration, eval_duration` (nanoseconds). Errors: status code + `{ error }`.
  - **lmstudio:** `GET /api/v1/models` → models with `max_context_length`, `loaded_instances` (`[{ config: { context_length } }]` when loaded), type `llm`/`vlm`, and `capabilities` including `tool_use`; `POST /api/v1/models/load` `{ model, context_length }` → marks it loaded with that window; `GET /v1/models`; `POST /v1/chat/completions` streaming OpenAI SSE (`data: {...}` chunks, `data: [DONE]`) with `usage` on the last chunk.
  - **openai:** `GET /v1/models` → `{ data: [{ id }] }`; `POST /v1/chat/completions` as above.
- Every request is pushed to `requests` with its parsed JSON body.
- Run as a script (`npm run fake-local -- --flavor ollama --port 11434`), it starts with `qwen3:1.7b` (tools, thinking, 40,960 context) and `gemma3:1b` (32,768 context) and replies `This is a reply from the fake local server.` in a few chunks with 50 ms between them.

- [ ] **Step 1: Write the failing test** `fakeLocalServer.test.ts`: starts an `ollama` fake with `qwen3:1.7b`, asserts `GET /api/tags` lists it, `POST /api/chat` after `reply({ text: ['Hel', 'lo'] })` streams lines whose `message.content` joins to `Hello` and ends with `done: true`, and `requests` recorded the chat body. Same for `lmstudio` against `/v1/chat/completions` (SSE ends with `[DONE]`) and `/api/v1/models/load` changing the reported loaded window.
- [ ] **Step 2: Run** `npx vitest run test/fakeLocalServer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:http` on port 0 (or `o.port`), listening on `127.0.0.1`.
- [ ] **Step 4: Run** the test. Expected: PASS. Then run `npm run fake-local -- --flavor ollama --port 11500` and `curl.exe http://localhost:11500/api/tags`; expected: the two default models. Stop it.
- [ ] **Step 5: Commit** `test: fake local model server`

---

### Task 3: Local server storage

**Files:**
- Modify: `server/src/db.ts` (SCHEMA + `migrate`)
- Create: `server/src/localServers.ts`
- Modify: `server/src/library.ts` (`removeModel` reused; `listLibrary` fills source fields)
- Modify: `server/src/messages.ts` (read/write `context_dropped`)
- Test: `server/test/localServers.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `localModelId`, `parseLocalModelId`, `normalizeBaseUrl`.
- Schema: `local_servers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('ollama','lmstudio','openai')), name TEXT NOT NULL, base_url TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, removed_at INTEGER, created_at INTEGER NOT NULL)`. Migrations: `models.context_window INTEGER`, `messages.context_dropped INTEGER NOT NULL DEFAULT 0`, following the `PRAGMA table_info` pattern in `migrate`.
- Produces (`server/src/localServers.ts`):
  - `listServers(db: DB): LocalServer[]` (not removed, by `created_at`)
  - `getServer(db: DB, id: string): LocalServer | null` (not removed)
  - `findServer(db: DB, type: LocalServerType, baseUrl: string, o?: { includeRemoved?: boolean }): (LocalServer & { removed: boolean }) | null`
  - `addServer(db: DB, s: { type: LocalServerType; name: string; baseUrl: string; auto: boolean }): LocalServer` — normalizes `baseUrl`; if a removed row with the same type and address exists, restores it (clears `removed_at`, applies the new name, `enabled = 1`) and returns it with its old id; if a live one exists, throws `HttpError(409, 'That server is already in your list.')`; new ids are the first 8 hex characters of `newId()`
  - `updateServer(db: DB, id: string, patch: { name?: string; baseUrl?: string; enabled?: boolean }): LocalServer` — keeps the id
  - `removeServer(db: DB, id: string): void` — sets `removed_at`, then calls `removeModel` for every `models.id` starting with `local:<id>:`
- `listLibrary` sets `source`, `serverId`, `serverName` (null if the server row is gone), `contextWindow` (from `context_window`), `capsKnown` (false only for models on `openai` servers).
- `modelContextLength(db, id)` returns `context_window ?? context_length`.

- [ ] **Step 1: Write the failing tests:**
  - `addServer` normalizes the address and a second add of `localhost:11434/` throws 409.
  - `updateServer` changing the address keeps the id and the models whose ids use it.
  - `removeServer` on the server of the default, title and memory model clears all three settings and removes its models from `listLibrary`, but `getChatMessages` for a chat that used it still returns the messages and `displayNameOf` falls back to the id (Review Focus 4).
  - Adding the same type and address after removal returns the **same id**.
  - `modelContextLength` prefers `context_window`.
  - An existing database without the new columns migrates (open a db built from the old SCHEMA string as `db.test.ts` does).
- [ ] **Step 2: Run** `npx vitest run server/test/localServers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file, then `npm test`. Expected: PASS everywhere.
- [ ] **Step 5: Commit** `feat(server): local server storage`

---

### Task 4: Provider types and the Ollama client

**Files:**
- Create: `server/src/providers/types.ts`
- Create: `server/src/providers/localHttp.ts`
- Create: `server/src/providers/ollama.ts`
- Modify: `server/src/openrouter.ts` (`OpenRouterError extends ProviderError`)
- Test: `server/test/ollamaClient.test.ts`

**Interfaces:**
- Produces (`providers/types.ts`):

```ts
export class ProviderError extends Error { constructor(message: string, public status: number) }
export class LocalServerError extends ProviderError {}
export interface ChatRequest {
  model: string; messages: ChatMessage[]; signal?: AbortSignal;
  plugins?: Plugin[]; webSearch?: WebSearchMode; tools?: FunctionTool[]; effort?: Effort;
  /** Local thinking models only: false turns thinking off; undefined leaves the model's default. */
  think?: boolean;
}
export interface CompleteRequest { model: string; messages: ChatMessage[]; maxTokens?: number; onUsage?: (u: Usage) => void }
export interface ChatProvider { streamChat(o: ChatRequest): AsyncGenerator<StreamEvent>; complete(o: CompleteRequest): Promise<string> }
export interface LocalModelInfo { name: string; sizeBytes: number | null; contextLength: number | null; inputModalities: string[]; supportsTools: boolean; supportsReasoning: boolean; capsKnown: boolean }
export interface LocalClient extends ChatProvider {
  listModels(): Promise<LocalModelInfo[]>;          // 1,500 ms timeout
  /** `contextWindow` is the window to run the model with. */
  streamChat(o: ChatRequest & { contextWindow?: number }): AsyncGenerator<StreamEvent>;
  complete(o: CompleteRequest & { contextWindow?: number }): Promise<string>;
}
```

- `localHttp.ts`: `localFetch(server: { name: string; baseUrl: string }, path: string, init: RequestInit & { timeoutMs?: number }, fetchImpl?: typeof fetch): Promise<Response>` — connection failures and timeouts throw `LocalServerError("Can't reach {name} at {host}. Is it running?", 0)`; a non-2xx answer throws `LocalServerError('{name} couldn't run this model: {detail}', status)` where detail is the JSON `error` (string or `.message`) or the status text; `AbortError` from the caller's signal is rethrown unchanged.
- `ollama.ts`: `createOllamaClient(server: { name: string; baseUrl: string }, fetchImpl?: typeof fetch): LocalClient`
  - `listModels`: `/api/tags`, then `/api/show` per model (at most 4 in flight); `contextLength` from the `model_info` key ending in `.context_length`; `inputModalities` `['text', 'image']` when capabilities include `vision`; `supportsTools` from `tools`; `supportsReasoning` from `thinking`; `capsKnown: true`.
  - `streamChat`: `POST /api/chat` with `{ model, messages, stream: true, options: { num_ctx: contextWindow }, think?, tools? }`. Messages are converted from OpenAI shape: text parts joined into `content`, `image_url` data URLs moved to `images: [base64]`, cache-marker objects flattened. `message.thinking` → `reasoning` events, `message.content` → `delta`, `message.tool_calls` → one `tool_call` event each after the stream ends with `arguments` as `JSON.stringify` of Ollama's object, final line → `usage` with `promptTokens: prompt_eval_count`, `completionTokens: eval_count`, `cost: 0`, other fields null. A line with `error` throws `LocalServerError`.
  - `complete`: same request with `stream: false`.
  - `webSearch`, `plugins` and `effort` are ignored.

- [ ] **Step 1: Write the failing tests** against `startFakeLocalServer({ flavor: 'ollama', ... })`:
  - `listModels` reports `qwen3:1.7b` with tools, reasoning, 40,960 context, and `gemma3:1b` without tools.
  - `streamChat` yields `reasoning` then `delta` events and a final usage with `cost: 0`; the recorded request has `options.num_ctx === 16384` when called with `contextWindow: 16384`, has `think: false` when asked, and has no `plugins`, `usage` or `cache_control` anywhere in it.
  - A tool call reply yields `{ type: 'tool_call', name: 'pass_to', arguments: '{"name":"Ada"}' }`.
  - An image attachment in OpenAI shape arrives as `images: ['<base64>']`.
  - Closed server: `listModels` rejects with `Can't reach Ollama at 127.0.0.1:<port>. Is it running?`.
  - `failNext(500, 'model requires more system memory')` → `Ollama couldn't run this model: model requires more system memory`.
  - Aborting the signal mid-stream rejects with an `AbortError`.
- [ ] **Step 2: Run** `npx vitest run server/test/ollamaClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): Ollama client`

---

### Task 5: LM Studio and OpenAI-compatible clients

**Files:**
- Create: `server/src/providers/openaiStream.ts`
- Create: `server/src/providers/lmstudio.ts`
- Create: `server/src/providers/openaiCompat.ts`
- Modify: `server/src/openrouter.ts` (use `openaiStream.ts` for chunk parsing; behavior unchanged)
- Test: `server/test/lmstudioClient.test.ts`

**Interfaces:**
- Produces:
  - `readChatStream(body: ReadableStream<Uint8Array>, onError: (status: number, message: string) => never): AsyncGenerator<StreamEvent>` — the SSE chunk loop now inside `OpenRouterClient.streamChat` (deltas, reasoning, annotations, tool-call assembly, usage via a `parseUsage` argument or returned raw), moved verbatim so `openrouter.test.ts` still passes.
  - `createLmStudioClient(server, fetchImpl?): LocalClient` — `listModels` from `GET /api/v1/models` (`max_context_length`; `vlm` → image input; `tool_use` capability → tools; `capsKnown: true`). Before a chat, if the model has no loaded instance, `POST /api/v1/models/load` with `context_length: contextWindow`; if it's loaded, its loaded window is used as is. Chat via `POST /v1/chat/completions` with `stream: true` and `stream_options: { include_usage: true }`. Usage cost 0. **Verify the `/api/v1` endpoints against LM Studio's current REST docs first; if model loading over REST isn't available, skip the load call and record that in the task's commit message.**
  - `createOpenAICompatClient(server, fetchImpl?): LocalClient` — `listModels` from `GET /v1/models` with `contextLength: null`, `capsKnown: false`, `supportsTools: false`, text-only; chat via `/v1/chat/completions`.
- Both send the request without OpenRouter-only fields (see Global Constraints) and send `tools` only when given.

- [ ] **Step 1: Write the failing tests** against `lmstudio` and `openai` fakes: model listing as above; an unloaded model gets one `load` request with `context_length: 16384` before the chat request, a loaded one gets none; streamed deltas join to the scripted text; usage has `cost: 0`; a model named `lmstudio-community/Qwen3-8B-GGUF` is sent with that exact `model` string (Review Focus 1); errors and abort behave as in Task 4.
- [ ] **Step 2: Run** `npx vitest run server/test/lmstudioClient.test.ts server/test/openrouter.test.ts`. Expected: new tests FAIL, OpenRouter tests PASS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): LM Studio and OpenAI-compatible clients`

---

### Task 6: Provider routing at every call site

**Files:**
- Create: `server/src/providers/index.ts`
- Modify: `server/src/generate.ts`, `server/src/compare.ts`, `server/src/continue.ts`, `server/src/title.ts`, `server/src/memorySuggest.ts`, `server/src/discussion/turn.ts`, `server/src/discussion/summary.ts`, `server/src/routes/generate.ts`
- Test: `server/test/providers.test.ts`, plus updates to `server/test/generate.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces (`providers/index.ts`):
  - `chatProvider(deps: Deps, modelId: string): ChatProvider` — for a local id: the server must exist and be enabled, else `LocalServerError('The server for this model was removed.', 404)` or `LocalServerError('{name} is turned off in Settings.', 409)`; returns a provider that sends the server's model name and the model's `context_window` (falling back to `defaultContextWindow(context_length)`). For an OpenRouter id: `resolveApiKey`; with no key throws `ProviderError('No OpenRouter API key set. Add one in Settings.', 401)`; otherwise wraps `deps.openrouter` passing `apiKey` and dropping `think`.
  - `localClientFor(server: LocalServer): LocalClient` — picks the client by `server.type`.
- `replyErrorMessage` (and every `instanceof OpenRouterError` used to pick a user-facing message) checks `ProviderError` instead.
- Each call site resolves the provider inside its `try`, and logs usage on failure only if the provider was resolved (the role `if (key)` plays today).
- `maybeGenerateTitle(deps, chatId, fallbackModel)` drops its `apiKey` parameter.
- Generation routes accept `thinking?: boolean` in the body (400 `thinking must be true or false.` otherwise) and pass `think: thinking` through `streamReply`/`streamComparison` to providers, only for local models whose `supports_reasoning` is 1.

- [ ] **Step 1: Write the failing tests** in `providers.test.ts` (using `makeApp` with **no** `OPENROUTER_API_KEY` in env and a running Ollama fake whose server and `qwen3:1.7b` model are inserted with `addServer`/`addModel`):
  - Sending to the local model streams the scripted reply, saves it with `cost: 0`, and titles the chat.
  - Compare between `gemma3:1b` and `qwen3:1.7b` on the fake returns two replies.
  - Regenerate and edit work with the local model.
  - With an OpenRouter model also in My models, sending to it errors with `No OpenRouter API key set. Add one in Settings.` while the local one still works (Review Focus 5).
  - A disabled server gives `Ollama is turned off in Settings.`; a closed fake gives the `Can't reach` message as the stream's `error` event, and no raw `fetch failed` text appears.
  - A Discussion with two local participants runs a turn; the summary works.
  - `thinking: false` reaches the fake as `think: false`.
- [ ] **Step 2: Run** `npx vitest run server/test/providers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and update existing tests that passed an `apiKey` to `maybeGenerateTitle`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): route every chat call through a provider`

---

### Task 7: Auto-detection and local server routes

**Files:**
- Create: `server/src/localDetect.ts`
- Create: `server/src/routes/localServers.ts`
- Modify: `server/src/app.ts` (mount at `/api/local-servers`), `server/src/index.ts` (detect once at startup without awaiting)
- Test: `server/test/localServerRoutes.test.ts`

**Interfaces:**
- Produces:
  - `detectLocalServers(db: DB, o?: { force?: boolean; candidates?: typeof DETECT_CANDIDATES }): Promise<void>` — pings each candidate (Ollama `GET /api/tags`, LM Studio `GET /v1/models`, 1,500 ms); one that answers and has no live row is added as `auto` with the name from `SERVER_TYPE_NAMES`. A removed row for it is restored only when `force` is true.
  - `serverStatuses(db: DB): Promise<LocalServerStatus[]>` — every listed server pinged in parallel via `listModels`; disabled ones are `online: false, error: null` without a request.
  - Routes (all return `LocalServerStatus[]` unless noted):
    - `GET /api/local-servers` — runs `detectLocalServers(db)` first, then statuses.
    - `POST /api/local-servers` `{ type, name, baseUrl }` — checks the connection with `listModels`; on failure 400 `Couldn't connect: {message}`; then `addServer`; 201.
    - `PATCH /api/local-servers/:id` `{ name?, baseUrl?, enabled? }` — a new address is connection-checked like POST.
    - `DELETE /api/local-servers/:id`
    - `POST /api/local-servers/detect` — `detectLocalServers(db, { force: true })`.
    - `GET /api/local-servers/models` → `LocalCatalog`: runs `detectLocalServers(db)` first (the spec detects when the Model Library opens), then models of every online enabled server, ids built with `localModelId`; also refreshes `context_length`, `input_modalities`, `supports_tools`, `supports_reasoning` of library models on those servers (not for `openai` servers, whose capabilities are user-set).
- Validation messages: `type must be ollama, lmstudio or openai.`, `Name is required.`, plus `normalizeBaseUrl`'s message, as 400s.

- [ ] **Step 1: Write the failing tests** (candidates pointed at fakes on random ports):
  - First `GET` with an Ollama fake running adds one `auto` server named `Ollama`, online with 2 models; a second `GET` doesn't duplicate it.
  - Removing it, then `GET` doesn't re-add it; `POST /detect` does, with the same id.
  - A hanging fake (`hang(true)`) reads as offline and the `GET` returns in under 3 s (Review Focus 2).
  - `POST` with `localhost:<port>/v1/` for a running fake stores `http://localhost:<port>`; a second `POST` of the same address is 409 (Review Focus 3); a `POST` to a closed port is 400 starting `Couldn't connect:`.
  - `GET /models` lists `local:<id>:qwen3:1.7b` and refreshes a stored model's capabilities.
- [ ] **Step 2: Run** `npx vitest run server/test/localServerRoutes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): local server detection and routes`

---

### Task 8: Adding and editing local models in the library

**Files:**
- Modify: `server/src/library.ts` (`addLocalModel`, `setContextWindow`, `setLocalCaps`)
- Modify: `server/src/routes/models.ts`
- Test: `server/test/models.test.ts` (extend)

**Interfaces:**
- Produces:
  - `addLocalModel(db: DB, m: LocalModel): void` — `display_name` = the model name, `prompt_price` and `completion_price` 0, `context_length` = max, `context_window = defaultContextWindow(max)`, capabilities from `m`; sets the default model when there is none, as `addModel` does.
  - `setContextWindow(db: DB, id: string, tokens: number): void` — local models only; 400 `The context window must be between 1,024 and {max} tokens.` (no upper bound when the max is unknown).
  - `setLocalCaps(db: DB, id: string, caps: { supportsTools?: boolean; supportsImages?: boolean }): void` — only for models on `openai` servers; 400 `This server reports what the model supports.` otherwise.
- Route changes:
  - `POST /api/models` with a local id: looks the model up on its server via `localClientFor(...).listModels()`; offline → 502 with the client's message; not listed → 404 `That model isn't on {server name} any more.`; else `addLocalModel`. With an OpenRouter id and no key → 400 `Add an OpenRouter key in Settings to use OpenRouter models.`
  - `PATCH /api/models` accepts `contextWindow?: number`, `supportsTools?: boolean`, `supportsImages?: boolean`.
  - `DELETE /api/models?id=` already works for local ids once the client encodes them (Review Focus 1).

- [ ] **Step 1: Write the failing tests:** add `local:<id>:qwen3:1.7b` from a running fake → listed with `source: 'local'`, `serverName: 'Ollama'`, `promptPrice: 0`, `contextWindow: 16384`, `contextLength: 40960`, `supportsTools: true`; `DELETE ?id=` with the encoded id removes it; `PATCH` window 32,768 works, 50,000 is 400; adding a model the fake doesn't have is 404; adding an OpenRouter model with no key is 400; `setLocalCaps` works on an `openai` server's model and is 400 on an Ollama one.
- [ ] **Step 2: Run** `npx vitest run server/test/models.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add local models to My models`

---

### Task 9: The check before sending (server)

**Files:**
- Create: `server/src/contextCheck.ts`
- Modify: `server/src/http.ts` (`HttpError` extra body), `server/src/app.ts` (`onError` spreads it), `server/src/routes/generate.ts`, `server/src/generate.ts`, `server/src/compare.ts`, `server/src/continue.ts` and its route
- Test: `server/test/contextCheck.test.ts`

**Interfaces:**
- Produces:
  - `HttpError(status, message, extra?: Record<string, unknown>)`; `onError` returns `{ error: message, ...extra }`.
  - `const OVERFLOW_MARGIN = 1_024` (room kept for the reply; erring toward asking)
  - `contextOverflow(db: DB, o: { chatId: string; parentId: string | null; newMessage: { content: string; attachments: AttachmentRow[] } | null; modelIds: string[] }): ContextOverflow[]` — for each **local** model id: `estimate` = `estimateContext(...)` over the active path ending at `parentId` (as `routes/context.ts` builds it), plus `textTokens(content)` and the attachments' estimate for `newMessage`; overflow when `estimate + OVERFLOW_MARGIN > window` where `window = modelContextLength`. OpenRouter models are never checked.
- Generation routes accept `allowOverflow?: boolean`. Before saving anything: `overflow = contextOverflow(...)`; if non-empty and not allowed → `HttpError(409, 'This chat is longer than {names} can remember.', { overflow })` where names are display names joined as `A`, `A and B`, `A, B and C`. If allowed, replies from the overflowing models are saved with `contextDropped: true` (`streamReply` and `streamComparison` take `droppedModelIds: Set<string>`).
- `POST /api/chats/:id/continue` accepts `allowOverflow?: boolean` and does the same check for its model with `newMessage: null` (no `contextDropped` to store; the summary is a new chat).

- [ ] **Step 1: Write the failing tests:** with a local model whose window is set to 2,048 and a chat whose path is ~3,000 estimated tokens: send → 409 with `overflow[0]` naming the model, window 2,048 and an estimate over it, and **no user message saved**; resend with `allowOverflow: true` → reply saved with `contextDropped: true` and still true after `GET /api/chats/:id`; a short chat → no 409; the same long chat with an OpenRouter model → no 409; Compare with one overflowing and one fitting local model → 409 lists only the overflowing one; regenerate and continue → 409 likewise.
- [ ] **Step 2: Run** `npx vitest run server/test/contextCheck.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): ask before sending more than a local model can hold`

---

### Task 10: Local chats are titled locally

**Files:**
- Modify: `server/src/title.ts`
- Test: `server/test/providers.test.ts` (extend)

**Interfaces:**
- Produces: `isLocalOnlyChat(db: DB, chatId: string): boolean` — true when the chat has at least one assistant message and every assistant message's `model_id` is a local id.
- Title model choice: `chosen = title_model_id || fallbackModel`; if `isLocalOnlyChat` and `chosen` is not local, use `fallbackModel` (the chat's own model).

- [ ] **Step 1: Write the failing tests:** with `title_model_id` set to an OpenRouter model and a key present, a local-only chat's title request goes to the fake (check `requests`) and never to `deps.openrouter.complete` (spy); a chat with one OpenRouter reply uses the chosen title model.
- [ ] **Step 2: Run** `npx vitest run server/test/providers.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): local-only chats are titled by their own model`

---

### Task 11: Export and wipe include local servers

**Files:**
- Modify: `server/src/exportData.ts` (add `localServers: SELECT * FROM local_servers`), `server/src/dataStore.ts` (`ALL_TABLES` gains `local_servers`)
- Test: `server/test/export.test.ts`, `server/test/dataStore.test.ts` (extend)

- [ ] **Step 1: Write the failing tests:** an export after `addServer` has `localServers` with that row in `data.json`; "Delete all my data" leaves `local_servers` empty.
- [ ] **Step 2: Run** `npx vitest run server/test/export.test.ts server/test/dataStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): export and wipe local servers`

---

### Task 12: Settings → Models (web)

**Files:**
- Modify: `web/src/api.ts` (local server calls, `ApiError`, `updateModel` patch fields, `allowOverflow`/`thinking` pass-through is in Task 13)
- Create: `web/src/pages/settings/LocalServersCard.tsx`
- Modify: `web/src/pages/settings/GeneralTab.tsx`
- Create: `web/src/lib/localServers.ts`, `web/src/lib/localServers.test.ts`

**Interfaces:**
- Consumes: Task 7 routes.
- Produces (`api.ts`): `localServers()`, `addLocalServer(body)`, `updateLocalServer(id, patch)`, `removeLocalServer(id)`, `detectLocalServers()` (all `Promise<LocalServerStatus[]>`), `localModels(): Promise<LocalCatalog>`, and `class ApiError extends Error { status: number; data: Record<string, unknown> }` thrown by `json()`.
- Produces (`lib/localServers.ts`): `statusLabel(s: LocalServerStatus): string` → `Online · 2 models` / `Online · 1 model` / `Offline` / `Turned off`; `defaultName(type: LocalServerType): string` (from `SERVER_TYPE_NAMES`); `defaultAddress(type): string` (`DETECT_CANDIDATES` address, empty for `openai`).
- UI: General tab's first heading becomes **Models**, holding the existing OpenRouter key card (heading `OpenRouter`, with the Global Constraints note under it) and `LocalServersCard`: one row per server with name, address, type, `statusLabel`, and Edit / Turn off (or Turn on) / Remove; an **Add server** form (type select defaulting to Ollama with its default address and name filled in, name, address, Save which shows the server's error inline on failure); a **Look for local servers** button. Under "Model for chat titles", the title-model note from Global Constraints.

- [ ] **Step 1: Write the failing test** for `statusLabel`, `defaultName`, `defaultAddress`.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/localServers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and the UI, following the existing card, row and button styles in `GeneralTab.tsx`.
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS. Then start `openchat-verify` from `.claude/launch.json` with `npm run fake-local -- --flavor ollama --port 11434` running, open Settings: the fake shows as `Ollama · Online · 2 models`; add `http://localhost:9` and see the inline `Couldn't connect:` error; turn the server off and on; remove it and bring it back with Look for local servers. Take a screenshot.
- [ ] **Step 5: Commit** `feat(web): local servers in Settings`

---

### Task 13: Model Library, picker and composer (web)

**Files:**
- Modify: `web/src/pages/ModelLibrary.tsx`, `web/src/components/ModelPicker.tsx`
- Create: `web/src/components/LocalModelCard.tsx`
- Create: `web/src/lib/localModels.ts`, `web/src/lib/localModels.test.ts`
- Create: `web/src/lib/thinking.ts`, `web/src/lib/thinking.test.ts`
- Modify: the composer component that renders the effort picker and the search toggle (find it from `ChatView.tsx:552`)

**Interfaces:**
- Produces (`lib/localModels.ts`):
  - `type SourceFilter = 'all' | 'openrouter' | string` (a server id)
  - `sourceOptions(servers: LocalServerStatus[]): { id: SourceFilter; label: string }[]` → `All`, `OpenRouter`, then each server's name
  - `formatSize(bytes: number | null): string` → `1.4 GB`, `815 MB`, `''`
  - `modelDetails(m: LibraryModel): string` → for local: `Free · local · 16K context` (window, via existing `formatContext`); OpenRouter unchanged from today's `details`
- Produces (`lib/thinking.ts`): `loadThinking(chatId: string | null): boolean` (default true) and `saveThinking(chatId: string | null, on: boolean)`, mirroring `lib/effort.ts` with keys `openchat.thinking.<chatId>` and `openchat.thinking.last`.
- Model Library (chat kind): a `Segmented` source filter above the browse area. **All** shows local servers' models first, then the OpenRouter catalog; **OpenRouter** shows today's view; a server shows only its models. Local models render as `LocalModelCard` (name, server name, `formatSize`, context, capability icons, `Free · local`, Add/Remove). With no key, the OpenRouter catalog still shows but its Add buttons are disabled and read `Needs key`. The browse heading reads `Browse` instead of `Browse OpenRouter`. **My models** rows show a source badge (`OpenRouter` or the server name); local rows get a context window number input (saved on blur through `updateModel`, showing the server's 400 message inline) and, for `capsKnown: false` models, two checkboxes `Can use tools` and `Can see images`.
- Picker: uses `modelDetails`.
- Composer: when the current model (or any model in Compare) is local with `supportsReasoning`, the effort picker is replaced by a chip `Thinking: On` / `Thinking: Off` stored with `lib/thinking.ts`, sent as `thinking: false` when off. When every chosen model is local, the search toggle is disabled with the tooltip `Set up web search in Settings`.

- [ ] **Step 1: Write the failing tests** for `sourceOptions`, `formatSize` (`1_500_000_000` → `1.4 GB`, `815_000_000` → `777 MB` using 1024-based units, `null` → `''`), `modelDetails`, and `loadThinking`/`saveThinking` (default true; per-chat value wins; last value seeds a new chat).
- [ ] **Step 2: Run** `npx vitest run web/src/lib/localModels.test.ts web/src/lib/thinking.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS. In the browser with the fake Ollama running and **no key**: the source filter lists `All / OpenRouter / Ollama`; add `qwen3:1.7b`; My models shows the `Ollama` badge and a 16384 window; the picker shows `Free · local · 16K context`; the Thinking chip appears; send a message and get the fake reply with reasoning shown. Take a screenshot.
- [ ] **Step 5: Commit** `feat(web): local models in the Model Library and composer`

---

### Task 14: Overflow prompt, dropped note, and no-key messages (web)

**Files:**
- Create: `web/src/components/ContextOverflowDialog.tsx`
- Modify: `web/src/api.ts` (`postStream` passes `overflow` from the error body into `StreamError`), `web/src/components/ChatView.tsx`, the assistant message component (find where `Message` content renders), `web/src/components/discussion/DiscussionSetup.tsx`, `web/src/pages/ImageThread.tsx:188`, `web/src/pages/VideoThread.tsx:155`
- Create: `web/src/lib/overflow.ts`, `web/src/lib/overflow.test.ts`

**Interfaces:**
- Produces (`lib/overflow.ts`): `overflowTitle(overflow: ContextOverflow[]): string` → `This chat is longer than {names} can remember.` with names joined as `A`, `A and B`, `A, B and C`.
- `ContextOverflowDialog({ overflow, onSummarize, onSendAnyway, onCancel })` — a modal in the existing overlay style with the three buttons from Global Constraints.
- `ChatView.run`: an `onError` carrying `overflow` before `start` stores `{ opts, overflow }` and returns `false` (the draft goes back as today). **Send anyway** reruns the same `opts` with `allowOverflow: true` in the body. **Summarize and continue** calls the existing summarize flow; if that call fails with an `ApiError` whose `data.overflow` is set, the dialog shows again with only **Summarize anyway** (retries with `allowOverflow: true`) and **Cancel**.
- Assistant messages with `contextDropped` show the dropped-context note from Global Constraints under the reply, styled like existing reply notes.
- No-key messages: `ChatView` no longer treats a missing key as blocking: `noKey` is removed and the home screen shows when there are models. With no models, the hint is the no-models copy from Global Constraints, plus `Ollama found with 2 models.` (from `api.localServers()`, first online server) linking to `#/models`. `DiscussionSetup` drops its key hint the same way. Images and Video use `Needs an OpenRouter key.` linking to `#/settings`.

- [ ] **Step 1: Write the failing test** for `overflowTitle` with one, two and three models.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/overflow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS. In the browser with the fake and no key: set the model's window to 1,024 in My models, send a long message → the dialog appears naming the model; **Cancel** keeps the draft; **Send anyway** sends and the reply shows the dropped note, still there after reload. With no models at all, the new hint shows `Ollama found with 2 models.` The Images tab shows `Needs an OpenRouter key.` Take screenshots.
- [ ] **Step 5: Commit** `feat(web): ask before overflowing a local model, and drop the key requirement`

---

### Task 15: Stage check with real Ollama

**Files:** none (verification only; fixes go in a commit of their own)

- [ ] **Step 1:** Run `npm test` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 2:** Ask the user to run the app (`npm run dev`) with their real Ollama (`qwen3:1.7b`, `gemma3:1b`) and **remove their OpenRouter key from Settings** for the check (they can paste it back afterwards). Walk them through: Ollama detected in Settings; both models added; a chat with each (reasoning visible for qwen3, Thinking Off removes it); edit and regenerate; Compare between the two; a Discussion with gemma3 participants and no moderator; Summarize and continue; the title of a local chat; the overflow dialog after lowering the window. Note anything that differs from the fake server's behavior; that is the only thing the automated tests can't cover.
- [ ] **Step 3:** Fix what the check finds, each with a failing test against the fake server first where possible, and commit.
