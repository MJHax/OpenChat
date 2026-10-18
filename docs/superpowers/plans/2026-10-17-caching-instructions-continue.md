# Prompt caching, per-chat instructions, and "Summarize and continue" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pieces 2, 6 and 5 of the spec: cache breakpoints for models that need them, per-chat instructions added after the global ones, and an 80% context warning with "Summarize and continue".

**Architecture:** All prompt shaping stays in `server/src/prompt.ts` (pure functions, unit-tested). Per-chat state lives as plain columns on `chats` (`instructions`, `context_note`, `continued_from`) so Track C's export can read them directly. Summarize is one non-streaming `openrouter.complete` call recorded in `usage_events` under a new purpose `'summary'`, so stats and Track C's spending limits count it.

**Tech Stack:** Hono, better-sqlite3, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-data-limits-and-polish-design.md` (sections 2, 5, 6)

## Global Constraints

- Every model call goes through OpenRouter.
- Keep each file's existing line endings (all files touched here are LF).
- Commit style `feat(server): …` / `feat(web): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Paid verification needs the user's OK first, with an estimated cost.
- Never touch the user's server on port 3000; verify with `OPENCHAT_PORT` set to another port.
- Done = `npx vitest run` and `npx tsc --noEmit` pass, the UI is checked in the browser, everything committed on `claude/prompt-track-5ddf04`.

## OpenRouter caching facts (checked 2026-10-17, openrouter.ai/docs/guides/best-practices/prompt-caching)

- Explicit `cache_control: { type: 'ephemeral' }` on a text content part is needed for Anthropic (`anthropic/*`) and Alibaba's Qwen endpoints (`qwen/qwen3-max`, `qwen/qwen-plus`, `qwen/qwen3.6-plus`, `qwen/qwen3-coder-plus`, `qwen/qwen3-coder-flash`, `deepseek/deepseek-v3.2`). OpenAI, DeepSeek (otherwise), Grok, Moonshot, Gemini 2.5+ cache automatically.
- Anthropic allows at most 4 breakpoints; we use 2. Minimum cacheable prefix is 512–4096 tokens by model; shorter prompts just don't cache (no extra charge).
- Usage reports `prompt_tokens_details.cached_tokens` / `cache_write_tokens`, already parsed in `openrouter.ts`.

## Decisions (builder's calls)

- Breakpoints go on the system message and on the **last text part of the last message** (the new user turn). The next turn's prompt shares that prefix, and Anthropic's 20-block lookback finds it. The docs show `cache_control` on system/user parts but not assistant parts, so this keeps to the documented shape. It also means a regenerate gets a full hit.
- The summary note is stored on the chat (`context_note`). The prompt sends it as a leading **user** message, `Context from a previous chat:\n\n<note>`. The seed assistant message comes after it, so the roles alternate.
- The seed message is a root assistant message (`parent_id` NULL, `model_id` NULL) with content `Files from the previous chat:` followed by one `<file name="…">` block per file. The UI renders a root assistant message as a "carried over" block without regenerate/copy actions.
- The note is editable while the chat has no user message; after that it is shown read-only.
- A continued chat is titled `<old title> (continued)`, so no title call is spent on it.
- The summarizing model is the chat's current model (the client sends it); the new chat's composer starts on that model.

## Review Focus

1. A Claude message whose last part is an image/PDF (text part first): the breakpoint must land on the text part, never on a non-text part. → Task 1 test `marks the last text part when attachments follow`.
2. An attachment-only last user message (no text part): the marker falls back to the nearest earlier message with a text part rather than crashing. → Task 1 test `falls back to an earlier message when the last has no text`.
3. Continuing a chat with no generated files: no seed message, and the prompt is `[system, note(user), user]`. → Task 4 test `continues without a seed when no files were made`.
4. Summarize fails at OpenRouter (402, 429): no new chat is created, the error reaches the client, and usage is logged as 'error'. → Task 4 test `creates nothing when the summary call fails`.
5. Per-chat instructions over the length cap, or not a string: 400, not silent truncation. → Task 2 test `rejects instructions that are too long or not text`.

---

### Task 1: Cache breakpoints (piece 2)

**Files:**
- Modify: `server/src/prompt.ts`, `server/src/generate.ts` (`promptFor`)
- Test: `server/test/prompt.test.ts`, `server/test/generate.test.ts`

**Interfaces:**
- Produces: `needsCacheMarkers(modelId: string): boolean`, `withCacheMarkers(modelId: string, messages: ChatMessage[]): ChatMessage[]` (returns the input unchanged for other models). `ContentPart` text variant gains optional `cache_control?: { type: 'ephemeral' }`.

- [ ] Tests in `prompt.test.ts` (`describe('withCacheMarkers')`):
  - `leaves other models' messages untouched`: `openai/gpt-4o` → `toBe(input)` (same reference).
  - `marks the system prompt and the last message for Claude`: `anthropic/claude-haiku-4.5`, [system 'S', user 'a', assistant 'b', user 'c'] → system content `[{type:'text',text:'S',cache_control:{type:'ephemeral'}}]`, last `[{type:'text',text:'c',cache_control:{type:'ephemeral'}}]`, the middle messages stay strings.
  - `marks the last text part when attachments follow`: last content `[text 'see', image_url]` → cache_control on parts[0] only.
  - `falls back to an earlier message when the last has no text`.
  - `needsCacheMarkers`: true for `anthropic/x` and `qwen/qwen3-max`, false for `qwen/qwen3-8b`, `openai/gpt-4o`, `google/gemini-2.5-flash`.
- [ ] Test in `generate.test.ts`: `sends cache breakpoints to Claude and plain strings to others`. Send in two chats via the `scripted` helper and assert on `calls[0]`.
- [ ] Run them and see them fail; implement them; apply `withCacheMarkers` at the end of `promptFor`; run them and see them pass. Commit `feat(server): prompt caching breakpoints for Claude and Qwen`.

### Task 2: Per-chat instructions: server (piece 6)

**Files:**
- Modify: `server/src/db.ts` (column `instructions TEXT NOT NULL DEFAULT ''` in SCHEMA + migration), `server/src/chats.ts`, `server/src/routes/chats.ts`, `server/src/prompt.ts`, `server/src/generate.ts`, `server/src/routes/context.ts`, `shared/types.ts`
- Test: `server/test/prompt.test.ts`, `server/test/chats.test.ts`, `server/test/context.test.ts` or `generate.test.ts`

**Interfaces:**
- `Persona` gains optional `chatInstructions?: string`. `buildSystemPrompt` puts `Instructions for this chat:\n<text>` right after the global `Instructions:` section. Titles and memory never pass it.
- `ChatDetail.chat.instructions: string`. `PATCH /api/chats/:id { instructions }` (string, ≤ 20,000 chars after trim, else 400). `POST /api/chats { kind?, instructions? }`.
- `chatPersona(db, chatId: string | null, draft?: string): Persona` in `server/src/settings.ts` returns the global persona plus that chat's instructions (or `draft` for an unsaved chat).
- `GET /api/context?model=…&chat=…&instructions=…`: `instructions` only counts when there is no `chat`.

- [ ] Tests: `buildSystemPrompt` orders `Instructions:` then `Instructions for this chat:`, and gives just the chat section when global is empty. Chat routes: `stores instructions on create and patch` (they show in the GET detail), `rejects instructions that are too long or not text`. Generation: `sends the chat's instructions after the global ones`. Context: the system part grows when instructions are set.
- [ ] Run them and see them fail, implement, run them and see them pass. Commit `feat(server): per-chat instructions`.

### Task 3: Per-chat instructions: web

**Files:**
- Create: `web/src/components/InstructionsButton.tsx`
- Modify: `web/src/components/ChatView.tsx`, `web/src/components/ContextPopover.tsx`, `web/src/api.ts`, `web/src/styles.css`

**Interfaces:**
- `api.createChat(kind, instructions?)`, `api.setInstructions(id, text): Promise<ChatDetail>`, `api.context(modelId, chatId, instructions?)`.
- `InstructionsButton({ value, onSave(text): Promise<void> })`: a header button labelled `Instructions` (with a dot when set), using `usePopover`. Its textarea has Save and Cancel buttons and a note: "Added after your global custom instructions."
- ChatView keeps `draftInstructions` for an unsaved chat and passes it to `createChat` in `ensureChat`.

- [ ] Implement it, then typecheck. The browser check is in Task 6. Commit `feat(web): per-chat instructions editor`.

### Task 4: Summarize and continue: server (piece 5)

**Files:**
- Create: `server/src/continue.ts`
- Modify: `server/src/db.ts` (`context_note TEXT`, `continued_from TEXT` on chats; `usage_events.purpose` CHECK gains `'summary'`, via a table rebuild in `migrate` when the stored SQL lacks it), `server/src/usage.ts` (`UsagePurpose`), `server/src/prompt.ts`, `server/src/context.ts`, `server/src/routes/context.ts`, `server/src/routes/chats.ts`, `server/src/chats.ts`, `shared/types.ts`, `web/src/components/stats/UsageChart.tsx` (legend copy "Background (titles, memory, summaries)")
- Test: `server/test/continue.test.ts`, `server/test/db.test.ts`, `server/test/prompt.test.ts`, `server/test/context.test.ts`

**Interfaces:**
- `SUMMARY_PROMPT` (exported): asks for a short plain-prose summary of what the chat is about, the decisions made, and the open questions. A few short paragraphs at most, no file contents, no headings.
- `seedContent(path: PathEntry[]): string | null`: the latest complete version of each generated file, in first-appearance order, as file blocks after `Files from the previous chat:`. Returns null when there are none.
- `continueChat(deps, chatId, modelId): Promise<ChatSummary>` in `continue.ts`. It sends `withCacheMarkers(model, [...buildMessages(chatPersona, path, attachments, files), { role:'user', content: SUMMARY_PROMPT }])` through `openrouter.complete` (maxTokens 2000) and records usage `purpose:'summary'` on the old chat. Then, in one transaction, it creates the new chat (title `<old> (continued)`, instructions copied, `context_note` = trimmed summary, `continued_from` = old id) plus the seed message, which becomes the active leaf. Throws `HttpError(502, …)` on an empty summary.
- `POST /api/chats/:id/continue { modelId }` → 201 `ChatSummary`. `PATCH /api/chats/:id { contextNote }` is allowed only while the chat has no user message (else 409), and the text must be non-empty and ≤ 20,000 chars.
- `ChatDetail.chat.contextNote: string | null`, `ChatDetail.chat.continuedFrom: { id: string; title: string | null } | null` (title null when the old chat is gone).
- `buildMessages(p, path, o?, files?, note?: string | null)`: with a note, a user message `Context from a previous chat:\n\n<note>` comes first after the system message. `estimateContext` takes `note: string | null` and counts it under `user`.

- [ ] Tests (continue.test.ts): `summarizes, then opens a new chat with the note, seed files and instructions`. It checks the complete() prompt ends with SUMMARY_PROMPT, the new chat's detail (note, continuedFrom, instructions, one root assistant message with only the latest `a.html` and `b.csv`), the old chat unchanged, and a usage row with purpose 'summary' on the old chat. `continues without a seed when no files were made`. `creates nothing when the summary call fails`. `locks the note once the chat has a user message`. `sends the note before the seed on the first reply` (asserts on streamChat calls roles: system,user,assistant,user). db.test: `migrates usage_events to allow summary rows, keeping old rows`.
- [ ] Run them and see them fail, implement, run them and see them pass. Commit `feat(server): summarize and continue in a new chat`.

### Task 5: Context warning and continue: web

**Files:**
- Create: `web/src/lib/context.ts` + `web/src/lib/context.test.ts`, `web/src/components/ContextNote.tsx`
- Modify: `web/src/components/ContextPopover.tsx` (takes usages from the parent, gets an amber `warn` class, adds a "Summarize and continue" button), `web/src/components/ChatView.tsx`, `web/src/components/MessageItem.tsx` (root assistant = carried-over block), `web/src/lib/models.ts` (`initialModelId(messages, models, preferred?)`), `web/src/api.ts`, `web/src/styles.css`

**Interfaces:**
- `contextLevel(fill: number | null): 'ok' | 'warn' | 'full'` with `WARN_AT = 0.8`. 'full' at ≥ 1.
- `useContextUsages(chatId, modelIds, refreshKey, instructions)` → `{ usages, error, fullest, fill }` lives in ContextPopover.tsx. ChatView calls it and passes the result down.
- `api.continueChat(id, modelId): Promise<ChatSummary>`, `api.setContextNote(id, text): Promise<ChatDetail>`.
- Notice above the composer at `warn`/`full`: "This chat is using N% of <model>'s context window." plus [Summarize and continue] and a dismiss ×. Dismissal is per chat, in memory. While summarizing, the buttons read "Summarizing…" and are disabled.
- `ContextNote({ note, from, editable, onSave })`: labelled "Context from the previous chat". It links to `#/chat/<from.id>`, or says "(deleted)". Editable as a textarea with Save; ChatView saves a dirty draft before sending.

- [ ] Tests: `contextLevel` boundaries (null→ok, 0.79→ok, 0.8→warn, 0.99→warn, 1→full). `initialModelId` uses `preferred` only when no assistant reply has a model.
- [ ] Run them and see them fail, implement, run them and see them pass, typecheck. Commit `feat(web): context warning and summarize and continue`.

### Task 6: Verify

- [ ] `npx vitest run` and `npx tsc --noEmit` all green.
- [ ] Start the server + Vite with `OPENCHAT_PORT=3017` on a copy-free fresh data dir (check how `server/src/index.ts` picks the DB path). Check in the browser: the Instructions editor on new and saved chats, the context number including instructions, the amber button and notice (forced by a small-context model or a seeded long chat), and the carried-over note and seed block, plus that the note locks after sending. Real model calls only with the user's OK.
- [ ] With the user's OK: one two-turn chat on a cheap Claude model. Expect `cached_tokens > 0` on turn 2 (the prompt must be ≥ the model's minimum, so turn 1 needs a long enough prompt). Run one real Summarize and continue on that chat.
