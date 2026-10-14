# Compare Models & "Remember This" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-chat side-by-side comparison of 2–4 models (with a persisted "pick a reply" step) and a "Remember" button that turns a message into an AI-suggested, editable memory fact.

**Architecture:** The server gains a `streamComparison` that runs several OpenRouter streams concurrently over one SSE response, tagging events with a `slot` index and saving each reply as a sibling under the user message. `chats.compare_parent_id` records a comparison awaiting a choice; generation is blocked (409) until `PATCH selectMessageId` picks one. A new `/api/memories/suggest` endpoint condenses text into a fact using a configurable memory model. The web client generalizes its pending-reply state to N "slots", renders comparisons with a shared `CompareColumns` component, adds a Compare toggle + model checklist to the composer, and a Remember box to every message.

**Tech Stack:** unchanged — Node 24, TypeScript 5, Hono 4, better-sqlite3 12, React 19, Vite 7, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-10-14-compare-and-remember-design.md` (builds on `docs/superpowers/specs/2026-10-14-openchat-design.md`)

## Global Constraints

- Comparisons take 2–4 distinct, non-empty model ids; anything else is 400.
- While `chats.compare_parent_id` is set, `/messages`, `/regenerate` and `/edit` return 409 "Pick a reply to continue."; `PATCH /api/chats/:id { selectMessageId }` always works and clears it.
- The single-model SSE protocol (`start`/`delta`/`reasoning`/`done`/`error`/`title`) is unchanged.
- Compare SSE events: `start {userMessageId, slots}`, `delta {slot,text}`, `reasoning {slot,text}`, `slot-done {slot,message}`, `slot-error {slot,message,partial}`, `done {compareParentId}`, optional `title {title}`.
- The per-chat generation lock covers a whole comparison and is released after every slot is saved, before titling.
- Existing databases must keep working: `compare_parent_id` is added by migration when missing.
- Memory suggestions use `memory_model_id`, else `default_model_id`, with `maxTokens: 1000`; text is truncated to 4,000 characters; the fact is cleaned to one line of at most 300 characters.
- Compare mode state is stored per chat in `localStorage` under `openchat.compare.<chatId>`; new chats start with Compare off.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two slots finishing at the same moment** → SSE frames must never interleave; every event parses. *(Task 2 test "runs every model and saves each reply as a version" checks every event parses and slot-done count; writes go through a serialized send queue.)*
2. **Stop during a comparison where some columns have text and some don't** → only the columns with text are saved (as stopped) and the choice step appears; none saved → "Generate reply" state. *(Task 2 test "client abort saves every slot that has text")*
3. **Opening an old database** (created before this feature) → server starts and chats load. *(Task 1 test "adds compare_parent_id to an existing database")*
4. **Regenerate in compare mode while an older reply exists** → old reply hidden until the user picks, and it appears as one of the columns. *(Task 2 test "regenerate with modelIds hides the previous reply until a choice is made")*
5. **Memory model returns quotes, markdown or several lines, or nothing** → one clean line, or a 502 that opens an empty box. *(Task 3 tests "cleans the suggestion to one line" and "502 when the model suggests nothing")*

---

## File Structure

```
server/src/
  db.ts                 (modify) compare_parent_id column + migration
  chats.ts              (modify) ChatRow.compare_parent_id, setCompareParent, detail.compare
  tree.ts               (modify) repliesTo()
  routes/chats.ts       (modify) GET /:id/replies; PATCH clears compare
  generate.ts           (modify) export replyErrorMessage
  compare.ts            (create) streamComparison
  routes/generate.ts    (modify) modelIds parsing, pending-choice 409, dispatch
  title.ts              (modify) new title rule + transcript
  memorySuggest.ts      (create) cleanFact, suggestMemory
  routes/memories.ts    (modify) POST /suggest
  settings.ts           (modify) memory_model_id
  library.ts            (modify) clear memory_model_id on removal
shared/types.ts         (modify) ChatDetail.compare, compare stream types, memoryModelId
server/test/
  compareState.test.ts  (create)
  compare.test.ts       (create)
  memorySuggest.test.ts (create)
web/src/
  api.ts                (modify) replies, suggestMemory, streamComparison
  lib/compare.ts        (create) compare-mode state helpers
  lib/compare.test.ts   (create)
  components/ThinkingIndicator.tsx (create, moved out of ChatView)
  components/CompareColumns.tsx    (create)
  components/RememberBox.tsx       (create)
  components/Composer.tsx          (modify) Compare toggle + checklist + hint
  components/MessageItem.tsx       (modify) Remember, Compare versions, compare-mode regenerate
  components/ChatView.tsx          (modify) slot-based pending state, compare flows
  pages/Settings.tsx               (modify) Model for memories
  styles.css                       (modify)
```

---

### Task 1: Comparison state in the database and chat API

**Files:**
- Modify: `server/src/db.ts`, `server/src/chats.ts`, `server/src/tree.ts`, `server/src/routes/chats.ts`, `shared/types.ts`
- Test: `server/test/compareState.test.ts`

**Interfaces:**
- Produces:
  - `tree.ts`: `repliesTo(messages: Message[], parentId: string): Message[]` — assistant children, oldest first
  - `chats.ts`: `ChatRow.compare_parent_id: string | null`, `setCompareParent(db, chatId, parentId: string | null): void`, `getChatDetail` now returns `compare`
  - `shared/types.ts`: `ChatDetail.compare: { parentId: string; replies: Message[] } | null`
  - Route: `GET /api/chats/:id/replies?parentId=` → `Message[]`; `PATCH /api/chats/:id { selectMessageId }` clears `compare_parent_id`

- [ ] **Step 1: Write the failing test `server/test/compareState.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from './appHelpers';
import { openDb } from '../src/db';
import { insertMessage } from '../src/messages';
import { setActiveLeaf, setCompareParent, getChatRow } from '../src/chats';
import type { ChatDetail, ChatSummary, Message } from '../../shared/types';

async function seed() {
  const ctx = makeApp();
  const chat = (await (await ctx.call('POST', '/api/chats')).json()) as ChatSummary;
  const u = insertMessage(ctx.db, { chatId: chat.id, parentId: null, role: 'user', content: 'Q' });
  const a = insertMessage(ctx.db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'A', modelId: 'm/a' });
  const b = insertMessage(ctx.db, { chatId: chat.id, parentId: u.id, role: 'assistant', content: 'B', modelId: 'm/b' });
  setActiveLeaf(ctx.db, chat.id, u.id);
  setCompareParent(ctx.db, chat.id, u.id);
  return { ...ctx, chat, u, a, b };
}

describe('comparison state', () => {
  it('adds compare_parent_id to an existing database', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openchat-')), 'old.db');
    const old = new Database(file);
    old.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_leaf_id TEXT)');
    old.prepare("INSERT INTO chats VALUES ('c1', 'Old chat', 1, 1, NULL)").run();
    old.close();
    const db = openDb(file);
    expect(getChatRow(db, 'c1')).toMatchObject({ title: 'Old chat', compare_parent_id: null });
    db.close();
  });

  it('chat detail lists every reply awaiting a choice', async () => {
    const { call, chat, u, a, b } = await seed();
    const detail = (await (await call('GET', `/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.id)).toEqual([u.id]);
    expect(detail.compare).toEqual({ parentId: u.id, replies: [expect.objectContaining({ id: a.id }), expect.objectContaining({ id: b.id })] });
  });

  it('detail.compare is null when no choice is pending', async () => {
    const { call } = makeApp();
    const chat = (await (await call('POST', '/api/chats')).json()) as ChatSummary;
    expect(((await (await call('GET', `/api/chats/${chat.id}`)).json()) as ChatDetail).compare).toBeNull();
  });

  it('choosing a reply clears the pending choice', async () => {
    const { call, chat, u, b } = await seed();
    const detail = (await (await call('PATCH', `/api/chats/${chat.id}`, { selectMessageId: b.id })).json()) as ChatDetail;
    expect(detail.compare).toBeNull();
    expect(detail.messages.map((m) => m.id)).toEqual([u.id, b.id]);
  });

  it('lists every version of a reply', async () => {
    const { call, chat, u, a, b } = await seed();
    const replies = (await (await call('GET', `/api/chats/${chat.id}/replies?parentId=${u.id}`)).json()) as Message[];
    expect(replies.map((m) => m.id)).toEqual([a.id, b.id]);
    expect((await call('GET', `/api/chats/${chat.id}/replies?parentId=${a.id}`)).status).toBe(400);
    expect((await call('GET', `/api/chats/${chat.id}/replies`)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/compareState.test.ts`
Expected: FAIL — `setCompareParent` is not exported from `../src/chats`.

- [ ] **Step 3: Add the column and migration in `server/src/db.ts`**

In `SCHEMA`, change the `chats` table to include the column:
```sql
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active_leaf_id TEXT,
  compare_parent_id TEXT
);
```
Replace `openDb` with:
```ts
export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Brings databases created by older versions up to the current schema. */
function migrate(db: DB): void {
  const chatColumns = (db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((c) => c.name);
  if (!chatColumns.includes('compare_parent_id')) db.exec('ALTER TABLE chats ADD COLUMN compare_parent_id TEXT');
}
```

- [ ] **Step 4: Add `repliesTo` to `server/src/tree.ts`**

Append:
```ts
/** Assistant replies to a user message, oldest first. */
export function repliesTo(messages: Message[], parentId: string): Message[] {
  return childrenOf(messages, parentId).filter((m) => m.role === 'assistant');
}
```

- [ ] **Step 5: Update `server/src/chats.ts`**

Add `compare_parent_id: string | null;` to `ChatRow`. Change the tree import to `import { activePath, repliesTo, withSiblings } from './tree';`. Add:
```ts
export function setCompareParent(db: DB, id: string, parentId: string | null): void {
  db.prepare('UPDATE chats SET compare_parent_id = ? WHERE id = ?').run(parentId, id);
}
```
Replace `getChatDetail` with:
```ts
export function getChatDetail(db: DB, id: string): ChatDetail {
  const row = requireChat(db, id);
  const all = getChatMessages(db, id);
  const totalCost = all.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  return {
    chat: { id: row.id, title: row.title, updatedAt: row.updated_at, totalCost, activeLeafId: row.active_leaf_id },
    messages: withSiblings(all, activePath(all, row.active_leaf_id)),
    compare: row.compare_parent_id ? { parentId: row.compare_parent_id, replies: repliesTo(all, row.compare_parent_id) } : null,
  };
}
```

- [ ] **Step 6: Update `shared/types.ts`**

Replace the `ChatDetail` interface with:
```ts
export interface ChatDetail {
  chat: ChatSummary & { activeLeafId: string | null };
  messages: PathMessage[];
  /** Set while a comparison's replies are waiting for the user to pick one. */
  compare: { parentId: string; replies: Message[] } | null;
}
```

- [ ] **Step 7: Update `server/src/routes/chats.ts`**

Change imports:
```ts
import { createChat, deleteChat, getChatDetail, listChats, renameChat, requireChat, setActiveLeaf, setCompareParent } from '../chats';
import { getChatMessages, getMessage } from '../messages';
import { newestLeafFrom, repliesTo } from '../tree';
```
In the PATCH handler, after `setActiveLeaf(db, id, newestLeafFrom(all, body.selectMessageId));` add:
```ts
      setCompareParent(db, id, null); // choosing a reply settles any pending comparison
```
Add before `r.delete(...)`:
```ts
  r.get('/:id/replies', (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    const parent = getMessage(db, c.req.query('parentId') ?? '');
    if (!parent || parent.chatId !== id || parent.role !== 'user') throw new HttpError(400, 'parentId must be a user message in this chat.');
    return c.json(repliesTo(getChatMessages(db, id), parent.id));
  });
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run server/test/compareState.test.ts` → Expected: 5 passed.
Run: `npm test` → Expected: all pass. Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server shared
git commit -m "feat(server): persist pending comparison choice and list reply versions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Streaming comparisons

**Files:**
- Create: `server/src/compare.ts`
- Modify: `server/src/generate.ts`, `server/src/routes/generate.ts`, `server/src/title.ts`, `shared/types.ts`
- Test: `server/test/compare.test.ts`

**Interfaces:**
- Consumes: Task 1 (`setCompareParent`, `ChatRow.compare_parent_id`, `repliesTo`).
- Produces:
  - `generate.ts`: `replyErrorMessage(err: unknown): string`
  - `compare.ts`: `streamComparison(c: Context, deps: Deps, o: { chatId: string; parentId: string; modelIds: string[]; userMessageId: string | null; onFinish?: () => void }): Response`
  - `shared/types.ts`: `CompareSlot`, `CompareStart`, `CompareSlotText`, `CompareSlotDone`, `CompareSlotError`, `CompareDone`
  - Generation routes accept `modelIds` and return 409 while a choice is pending.
  - Title rule: chat titled `New chat` and ≥1 complete reply; transcript appends the first complete reply when the path ends at a user message.

- [ ] **Step 1: Write the failing test `server/test/compare.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { OpenRouterError, type OpenRouterClient, type StreamEvent } from '../src/openrouter';
import type { ChatMessage } from '../src/prompt';
import { getChatMessages } from '../src/messages';
import { getChatRow } from '../src/chats';
import type { ChatDetail, ChatSummary, Message } from '../../shared/types';

type Script = { chunks: string[]; failWith?: Error; hang?: boolean };

/** Fake streamChat whose behaviour depends on the model. Records the models called and their prompts. */
function byModel(script: Record<string, Script>) {
  const calls: { model: string; messages: ChatMessage[] }[] = [];
  const streamChat: OpenRouterClient['streamChat'] = async function* ({ model, messages, signal }): AsyncGenerator<StreamEvent> {
    calls.push({ model, messages });
    const s = script[model] ?? { chunks: [`reply from ${model}`] };
    for (const text of s.chunks) yield { type: 'delta', text };
    if (s.hang) {
      const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise((_, reject) => {
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()));
      });
    }
    if (s.failWith) throw s.failWith;
    yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, cost: 0.001 } };
  };
  return { streamChat, calls };
}

async function newChat(call: ReturnType<typeof makeApp>['call']) {
  return ((await (await call('POST', '/api/chats')).json()) as ChatSummary).id;
}

const IDS = ['m/a', 'm/b', 'm/c'];

describe('comparisons', () => {
  it('runs every model and saves each reply as a version', async () => {
    const { streamChat, calls } = byModel({});
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: IDS }));

    expect(calls.map((c) => c.model).sort()).toEqual(IDS);
    const start = events[0];
    expect(start.event).toBe('start');
    expect(start.data.slots.map((s: { modelId: string }) => s.modelId)).toEqual(IDS);
    expect(events.filter((e) => e.event === 'delta').every((e) => typeof e.data.slot === 'number')).toBe(true);
    const slotDone = events.filter((e) => e.event === 'slot-done');
    expect(slotDone.map((e) => e.data.slot).sort()).toEqual([0, 1, 2]);
    const done = events.find((e) => e.event === 'done')!;
    expect(done.data).toEqual({ compareParentId: start.data.userMessageId });

    const replies = getChatMessages(db, chatId).filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.modelId).sort()).toEqual(IDS);
    expect(replies.every((m) => m.parentId === start.data.userMessageId && m.status === 'complete')).toBe(true);
    expect(getChatRow(db, chatId)).toMatchObject({ compare_parent_id: start.data.userMessageId, active_leaf_id: start.data.userMessageId });

    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.role)).toEqual(['user']);
    expect(detail.compare?.replies).toHaveLength(3);
  });

  it('one model failing mid-stream keeps its partial and lets the others finish', async () => {
    const { streamChat } = byModel({ 'm/b': { chunks: ['Hal'], failWith: new OpenRouterError('The model provider returned an error.', 502) } });
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: IDS }));
    const failed = events.find((e) => e.event === 'slot-error')!;
    expect(failed.data).toMatchObject({ slot: 1, message: 'The model provider returned an error.', partial: { content: 'Hal', status: 'stopped' } });
    expect(events.filter((e) => e.event === 'slot-done').map((e) => e.data.slot).sort()).toEqual([0, 2]);
    expect(events.find((e) => e.event === 'done')!.data.compareParentId).toBeTruthy();
  });

  it('clears the pending choice when no model replies', async () => {
    const fail = { chunks: [], failWith: new OpenRouterError('Rate limited.', 429) };
    const { streamChat } = byModel({ 'm/a': fail, 'm/b': fail });
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['m/a', 'm/b'] }));
    expect(events.filter((e) => e.event === 'slot-error')).toHaveLength(2);
    expect(events.find((e) => e.event === 'done')!.data).toEqual({ compareParentId: null });
    expect(getChatRow(db, chatId)?.compare_parent_id).toBeNull();
    expect(getChatMessages(db, chatId).map((m) => m.role)).toEqual(['user']);
  });

  it('client abort saves every slot that has text', async () => {
    const { streamChat } = byModel({ 'm/a': { chunks: ['Part'], hang: true }, 'm/b': { chunks: [], hang: true } });
    const { app, call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const controller = new AbortController();
    const res = await app.request(new Request(`http://localhost/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Q', modelIds: ['m/a', 'm/b'] }),
      signal: controller.signal,
    }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: delta')) seen += dec.decode((await reader.read()).value);
    controller.abort();
    await reader.cancel().catch(() => {});

    let replies: Message[] = [];
    for (let i = 0; i < 50 && replies.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
      replies = getChatMessages(db, chatId).filter((m) => m.role === 'assistant');
    }
    await new Promise((r) => setTimeout(r, 50));
    replies = getChatMessages(db, chatId).filter((m) => m.role === 'assistant');
    expect(replies).toEqual([expect.objectContaining({ modelId: 'm/a', content: 'Part', status: 'stopped' })]);
  });

  it('blocks new generations until a reply is chosen, then continues from it', async () => {
    const { streamChat, calls } = byModel({});
    const { call, db } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['m/a', 'm/b'] }));
    const userId = events[0].data.userMessageId;

    const blocked = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Next', modelId: 'm/a' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toBe('Pick a reply to continue.');
    expect((await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelId: 'm/a' })).status).toBe(409);
    expect((await call('POST', `/api/chats/${chatId}/edit`, { messageId: userId, content: 'x', modelId: 'm/a' })).status).toBe(409);

    const chosen = getChatMessages(db, chatId).find((m) => m.modelId === 'm/b')!;
    const detail = (await (await call('PATCH', `/api/chats/${chatId}`, { selectMessageId: chosen.id })).json()) as ChatDetail;
    expect(detail.compare).toBeNull();

    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Next', modelId: 'm/a' }));
    expect(calls.at(-1)!.messages.map((m) => m.content)).toEqual(['Q', 'reply from m/b', 'Next']);
  });

  it('the lock covers the whole comparison', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const streamChat: OpenRouterClient['streamChat'] = async function* ({ model }) {
      yield { type: 'delta', text: model };
      if (model === 'm/b') await gate;
    };
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const running = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelIds: ['m/a', 'm/b'] });
    const busy = await call('POST', `/api/chats/${chatId}/messages`, { content: 'Again', modelId: 'm/a' });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toMatch(/still being generated/);
    release();
    await readEvents(running);
  });

  it('regenerate with modelIds hides the previous reply until a choice is made', async () => {
    const { streamChat } = byModel({});
    const { call } = makeApp({ streamChat });
    const chatId = await newChat(call);
    const first = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', modelId: 'm/a' }));
    const userId = first[0].data.userMessageId;
    await readEvents(await call('POST', `/api/chats/${chatId}/regenerate`, { parentId: userId, modelIds: ['m/b', 'm/c'] }));
    const detail = (await (await call('GET', `/api/chats/${chatId}`)).json()) as ChatDetail;
    expect(detail.messages.map((m) => m.id)).toEqual([userId]);
    expect(detail.compare?.replies.map((m) => m.modelId)).toEqual(['m/a', 'm/b', 'm/c']);
  });

  it('validates modelIds', async () => {
    const { call } = makeApp();
    const chatId = await newChat(call);
    const send = (body: object) => call('POST', `/api/chats/${chatId}/messages`, { content: 'Q', ...body });
    expect((await send({ modelIds: ['m/a'] })).status).toBe(400);
    expect((await send({ modelIds: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'] })).status).toBe(400);
    expect((await send({ modelIds: ['m/a', 'm/a'] })).status).toBe(400);
    expect((await send({ modelIds: ['m/a', ' '] })).status).toBe(400);
    expect((await send({ modelIds: ['m/a', 'm/b'], modelId: 'm/a' })).status).toBe(400);
    expect((await send({ modelIds: 'm/a' })).status).toBe(400);
  });

  it('titles a new chat after its first comparison using the first complete reply', async () => {
    const { streamChat } = byModel({ 'm/a': { chunks: [], failWith: new OpenRouterError('Rate limited.', 429) } });
    let transcript = '';
    const complete: OpenRouterClient['complete'] = async ({ messages }) => {
      transcript = messages.at(-1)!.content;
      return 'Compared chat';
    };
    const { call, db } = makeApp({ streamChat, complete });
    const chatId = await newChat(call);
    const events = await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Question', modelIds: ['m/a', 'm/b'] }));
    expect(events.at(-1)).toEqual({ event: 'title', data: { title: 'Compared chat' } });
    expect(transcript).toBe('user: Question\n\nassistant: reply from m/b');
    expect(getChatRow(db, chatId)?.title).toBe('Compared chat');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/compare.test.ts`
Expected: FAIL — 400 "Pick a model first." / missing events (comparisons not implemented).

- [ ] **Step 3: Add compare stream types to `shared/types.ts`**

Append:
```ts
// Server-sent events emitted when a generation endpoint is called with `modelIds` (a comparison)
export interface CompareSlot { assistantMessageId: string; modelId: string }
export interface CompareStart { userMessageId: string | null; slots: CompareSlot[] }
export interface CompareSlotText { slot: number; text: string }
export interface CompareSlotDone { slot: number; message: Message }
export interface CompareSlotError { slot: number; message: string; partial: Message | null }
export interface CompareDone { compareParentId: string | null }
```

- [ ] **Step 4: Extract `replyErrorMessage` in `server/src/generate.ts`**

Add after the imports:
```ts
export function replyErrorMessage(err: unknown): string {
  if (err instanceof OpenRouterError) return err.message;
  console.error(err);
  return 'Something went wrong while generating the reply.';
}
```
In `run`'s catch block replace:
```ts
      const message = err instanceof OpenRouterError ? err.message : 'Something went wrong while generating the reply.';
      if (!(err instanceof OpenRouterError)) console.error(err);
      await send('error', { message, partial } satisfies StreamError);
```
with:
```ts
      await send('error', { message: replyErrorMessage(err), partial } satisfies StreamError);
```

- [ ] **Step 5: Create `server/src/compare.ts`**

```ts
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Deps } from './app';
import { newId } from './db';
import { setActiveLeaf, setCompareParent, touchChat } from './chats';
import { replyErrorMessage } from './generate';
import { getChatMessages, insertMessage } from './messages';
import { OpenRouterError, type Usage } from './openrouter';
import { buildMessages } from './prompt';
import { getPersona, resolveApiKey } from './settings';
import { maybeGenerateTitle } from './title';
import { activePath } from './tree';
import type {
  CompareDone, CompareSlot, CompareSlotDone, CompareSlotError, CompareSlotText, CompareStart, Message, MessageStatus, StreamTitle,
} from '../../shared/types';

interface CompareOptions {
  chatId: string;
  /** The user message every model replies to. */
  parentId: string;
  modelIds: string[];
  /** Set when this request created a new user message. */
  userMessageId: string | null;
  /** Called once, when every reply is saved or the stream ends, whichever comes first. */
  onFinish?: () => void;
}

/**
 * Streams replies from several models to the same user message, concurrently, over one SSE response:
 * start → (delta|reasoning|slot-done|slot-error)* → done, then optional title. Each reply is saved as a
 * sibling under `parentId`, and the chat waits for the user to pick one (compare_parent_id).
 */
export function streamComparison(c: Context, deps: Deps, o: CompareOptions): Response {
  const { db, openrouter, env } = deps;
  const prompt = buildMessages(getPersona(db), activePath(getChatMessages(db, o.chatId), o.parentId));
  const { key } = resolveApiKey(db, env);
  const slots: CompareSlot[] = o.modelIds.map((modelId) => ({ assistantMessageId: newId(), modelId }));
  const abort = new AbortController();
  let finished = false;
  c.req.raw.signal.addEventListener('abort', () => abort.abort());

  setActiveLeaf(db, o.chatId, o.parentId);
  setCompareParent(db, o.chatId, o.parentId);

  return streamSSE(c, async (stream) => {
    try {
      await run(stream);
    } finally {
      finish();
    }
  });

  function finish() {
    if (finished) return;
    finished = true;
    o.onFinish?.();
  }

  async function run(stream: SSEStreamingApi) {
    stream.onAbort(() => abort.abort());
    // Slots write concurrently; chaining every write keeps SSE frames from interleaving.
    let queue: Promise<unknown> = Promise.resolve();
    const send = (event: string, data: unknown) =>
      (queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));

    await send('start', { userMessageId: o.userMessageId, slots } satisfies CompareStart);
    const saved = (await Promise.all(slots.map((slot, i) => runSlot(i, slot, send)))).filter((m): m is Message => m !== null);

    if (saved.length === 0) setCompareParent(db, o.chatId, null);
    touchChat(db, o.chatId);
    if (abort.signal.aborted) return;
    await send('done', { compareParentId: saved.length ? o.parentId : null } satisfies CompareDone);
    finish(); // every reply is saved; titling below shouldn't block the chat

    const firstComplete = saved.find((m) => m.status === 'complete');
    if (firstComplete) {
      const title = await maybeGenerateTitle(deps, o.chatId, key, firstComplete.modelId!);
      if (title) await send('title', { title } satisfies StreamTitle);
    }
  }

  async function runSlot(i: number, slot: CompareSlot, send: (event: string, data: unknown) => Promise<unknown>): Promise<Message | null> {
    let text = '';
    let usage: Usage | null = null;
    const save = (status: MessageStatus): Message =>
      insertMessage(db, {
        id: slot.assistantMessageId,
        chatId: o.chatId,
        parentId: o.parentId,
        role: 'assistant',
        content: text,
        modelId: slot.modelId,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        cost: usage?.cost ?? null,
        status,
      });

    try {
      if (!key) throw new OpenRouterError('No OpenRouter API key set. Add one in Settings.', 401);
      for await (const event of openrouter.streamChat({ apiKey: key, model: slot.modelId, messages: prompt, signal: abort.signal })) {
        if (event.type === 'delta') {
          text += event.text;
          await send('delta', { slot: i, text: event.text } satisfies CompareSlotText);
        } else if (event.type === 'reasoning') {
          await send('reasoning', { slot: i, text: event.text } satisfies CompareSlotText);
        } else {
          usage = event.usage;
        }
      }
      const message = save('complete');
      await send('slot-done', { slot: i, message } satisfies CompareSlotDone);
      return message;
    } catch (err) {
      const partial = text ? save('stopped') : null;
      if (!abort.signal.aborted) await send('slot-error', { slot: i, message: replyErrorMessage(err), partial } satisfies CompareSlotError);
      return partial;
    }
  }
}
```

- [ ] **Step 6: Replace `server/src/routes/generate.ts`**

```ts
import { Hono, type Context } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { requireChat, setActiveLeaf, touchChat, type ChatRow } from '../chats';
import { getMessage, insertMessage } from '../messages';
import { streamReply } from '../generate';
import { streamComparison } from '../compare';
import type { DB } from '../db';
import type { Message } from '../../../shared/types';

const requireText = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, error);
  return value;
};

/** One model (`modelId`) or a comparison of 2–4 distinct models (`modelIds`). */
function requireModels(body: { modelId?: unknown; modelIds?: unknown }): string[] {
  if (body.modelIds === undefined) return [requireText(body.modelId, 'Pick a model first.')];
  if (body.modelId !== undefined) throw new HttpError(400, 'Send modelId or modelIds, not both.');
  if (!Array.isArray(body.modelIds) || body.modelIds.length < 2 || body.modelIds.length > 4) {
    throw new HttpError(400, 'Compare needs 2 to 4 models.');
  }
  const ids = body.modelIds.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new HttpError(400, 'Compare models must be different and non-empty.');
  return ids;
}

function requireUserMessage(db: DB, chatId: string, id: unknown): Message {
  const message = typeof id === 'string' ? getMessage(db, id) : undefined;
  if (!message || message.chatId !== chatId || message.role !== 'user') {
    throw new HttpError(400, 'That message is not a user message in this chat.');
  }
  return message;
}

export function generationRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();
  // Chats with a reply currently streaming; a second generation would fork the tree mid-reply.
  const inFlight = new Set<string>();

  /** Reserves the chat for one generation. A running generation wins over a pending choice (it sets that choice). */
  function claim(chat: ChatRow): void {
    if (inFlight.has(chat.id)) throw new HttpError(409, 'A reply is still being generated in this chat. Wait for it to finish.');
    if (chat.compare_parent_id) throw new HttpError(409, 'Pick a reply to continue.');
    inFlight.add(chat.id);
  }

  function reply(c: Context, o: { chatId: string; parentId: string; modelIds: string[]; userMessageId: string | null }): Response {
    const onFinish = () => inFlight.delete(o.chatId);
    try {
      if (o.modelIds.length === 1) {
        return streamReply(c, deps, { chatId: o.chatId, parentId: o.parentId, modelId: o.modelIds[0], userMessageId: o.userMessageId, onFinish });
      }
      return streamComparison(c, deps, { ...o, onFinish });
    } catch (err) {
      inFlight.delete(o.chatId);
      throw err;
    }
  }

  r.post('/:id/messages', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ content?: string; modelId?: unknown; modelIds?: unknown }>(c);
    const content = requireText(body.content, 'Message is empty.');
    const modelIds = requireModels(body);
    claim(chat);
    const user = insertMessage(db, { chatId, parentId: chat.active_leaf_id, role: 'user', content });
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return reply(c, { chatId, parentId: user.id, modelIds, userMessageId: user.id });
  });

  r.post('/:id/regenerate', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ parentId?: string; modelId?: unknown; modelIds?: unknown }>(c);
    const parent = requireUserMessage(db, chatId, body.parentId);
    const modelIds = requireModels(body);
    claim(chat);
    return reply(c, { chatId, parentId: parent.id, modelIds, userMessageId: null });
  });

  r.post('/:id/edit', async (c) => {
    const chatId = c.req.param('id');
    const chat = requireChat(db, chatId);
    const body = await readJson<{ messageId?: string; content?: string; modelId?: unknown; modelIds?: unknown }>(c);
    const original = requireUserMessage(db, chatId, body.messageId);
    const content = requireText(body.content, 'Message is empty.');
    const modelIds = requireModels(body);
    claim(chat);
    const user = insertMessage(db, { chatId, parentId: original.parentId, role: 'user', content });
    setActiveLeaf(db, chatId, user.id);
    touchChat(db, chatId);
    return reply(c, { chatId, parentId: user.id, modelIds, userMessageId: user.id });
  });

  return r;
}
```

- [ ] **Step 7: Update the title rule in `server/src/title.ts`**

Change the tree import to `import { activePath, repliesTo } from './tree';`. Replace:
```ts
  const all = getChatMessages(db, chatId);
  // Title after the first complete reply; earlier stopped/partial replies don't count.
  if (all.filter((m) => m.role === 'assistant' && m.status === 'complete').length !== 1) return null;
  const transcript = activePath(all, chat.active_leaf_id)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(0, 4000);
```
with:
```ts
  const all = getChatMessages(db, chatId);
  // Title once any reply has completed; stopped/partial replies don't count.
  if (!all.some((m) => m.role === 'assistant' && m.status === 'complete')) return null;
  const path = activePath(all, chat.active_leaf_id);
  const last = path.at(-1);
  // During a comparison the path ends at the user message; include the first complete reply.
  if (last?.role === 'user') {
    const reply = repliesTo(all, last.id).find((m) => m.status === 'complete');
    if (reply) path.push(reply);
  }
  const transcript = path
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(0, 4000);
```
Update the doc comment to `/** Titles a chat once it has a complete reply. Never throws; returns the new title or null. */`.

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run server/test/compare.test.ts` → Expected: 9 passed.
Run: `npm test` → Expected: all pass (existing generate tests unchanged). Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server shared
git commit -m "feat(server): stream comparisons across 2-4 models with a pick-a-reply step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Memory suggestions and the memory-model setting

**Files:**
- Create: `server/src/memorySuggest.ts`
- Modify: `server/src/settings.ts`, `server/src/library.ts`, `server/src/routes/memories.ts`, `shared/types.ts`
- Test: `server/test/memorySuggest.test.ts`

**Interfaces:**
- Produces:
  - `settings.ts`: `memory_model_id` setting; `SettingsView.memoryModelId`, `SettingsUpdate.memoryModelId`
  - `memorySuggest.ts`: `MEMORY_PROMPT: string`, `cleanFact(raw: string): string`, `suggestMemory(deps: Deps, text: unknown): Promise<string>` (throws `HttpError` 400/502)
  - Route: `POST /api/memories/suggest { text }` → `{ suggestion: string }`

- [ ] **Step 1: Write the failing test `server/test/memorySuggest.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { OpenRouterError, type OpenRouterClient } from '../src/openrouter';
import { cleanFact } from '../src/memorySuggest';
import { updateSettings } from '../src/settings';
import type { LibraryModel, SettingsView } from '../../shared/types';

function capture(reply: string | Error = 'User lives in a farming town.') {
  const calls: Parameters<OpenRouterClient['complete']>[0][] = [];
  const complete: OpenRouterClient['complete'] = async (o) => {
    calls.push(o);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { complete, calls };
}

const suggest = (call: ReturnType<typeof makeApp>['call'], text: unknown) => call('POST', '/api/memories/suggest', { text });

describe('memory suggestions', () => {
  it('uses the memory model with a reasoning-safe budget', async () => {
    const { complete, calls } = capture();
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default', memoryModelId: 'm/memory' });
    const res = await suggest(call, 'I live in a small farming town of 50 people.');
    expect(await res.json()).toEqual({ suggestion: 'User lives in a farming town.' });
    expect(calls[0]).toMatchObject({ model: 'm/memory', maxTokens: 1000 });
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[1]).toEqual({ role: 'user', content: 'I live in a small farming town of 50 people.' });
  });

  it('falls back to the default model and truncates long text', async () => {
    const { complete, calls } = capture();
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    await suggest(call, 'x'.repeat(5000));
    expect(calls[0].model).toBe('m/default');
    expect(calls[0].messages[1].content).toHaveLength(4000);
  });

  it('cleans the suggestion to one line', async () => {
    const { complete } = capture('\n\n**"User prefers metric units."**\nExtra explanation');
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    expect(await (await suggest(call, 'I use metric')).json()).toEqual({ suggestion: 'User prefers metric units.' });
  });

  it('400 for empty text, no model, or no API key', async () => {
    const withModel = makeApp();
    updateSettings(withModel.db, { defaultModelId: 'm/default' });
    expect((await suggest(withModel.call, '   ')).status).toBe(400);
    expect((await suggest(withModel.call, 42)).status).toBe(400);

    const noModel = makeApp();
    const res = await suggest(noModel.call, 'hello');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Add a model in the Model Library first.');

    const noKey = makeApp({}, {});
    updateSettings(noKey.db, { defaultModelId: 'm/default' });
    expect((await suggest(noKey.call, 'hello')).status).toBe(400);
  });

  it('502 with the OpenRouter message when the call fails', async () => {
    const { complete } = capture(new OpenRouterError('Your OpenRouter account is out of credits.', 402));
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    const res = await suggest(call, 'hello');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('Your OpenRouter account is out of credits.');
  });

  it('502 when the model suggests nothing', async () => {
    const { complete } = capture('  \n ');
    const { call, db } = makeApp({ complete });
    updateSettings(db, { defaultModelId: 'm/default' });
    const res = await suggest(call, 'hello');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/Type the fact yourself/);
  });

  it('exposes the memory model setting and clears it when the model is removed', async () => {
    const { call } = makeApp({ listModels: async () => [] });
    await call('POST', '/api/models', { id: 'm/memory' });
    const view = (await (await call('PUT', '/api/settings', { memoryModelId: 'm/memory' })).json()) as SettingsView;
    expect(view.memoryModelId).toBe('m/memory');
    (await (await call('DELETE', '/api/models?id=m%2Fmemory')).json()) as LibraryModel[];
    expect(((await (await call('GET', '/api/settings')).json()) as SettingsView).memoryModelId).toBe('');
  });
});

describe('cleanFact', () => {
  it('keeps the first non-empty line without quotes or markdown, max 300 chars', () => {
    expect(cleanFact('- "User has a dog named Max."')).toBe('User has a dog named Max.');
    expect(cleanFact('\n\n`Fact`\nmore')).toBe('Fact');
    expect(cleanFact('a'.repeat(400))).toHaveLength(300);
    expect(cleanFact('   ')).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/test/memorySuggest.test.ts`
Expected: FAIL — cannot resolve `../src/memorySuggest`.

- [ ] **Step 3: Add the setting**

`shared/types.ts`: add `memoryModelId: string;` to `SettingsView` (after `titleModelId`) and `memoryModelId: string;` inside the `Partial<{ ... }>` of `SettingsUpdate`.

`server/src/settings.ts`:
- add `memory_model_id: '',` to `DEFAULTS`
- add `memoryModelId: 'memory_model_id',` to `UPDATE_KEYS`
- add `memoryModelId: getSetting(db, 'memory_model_id'),` to the object returned by `getSettingsView`

`server/src/library.ts`, in `removeModel`, after the `title_model_id` line add:
```ts
  if (getSetting(db, 'memory_model_id') === id) setSetting(db, 'memory_model_id', '');
```

- [ ] **Step 4: Create `server/src/memorySuggest.ts`**

```ts
import type { Deps } from './app';
import { HttpError } from './http';
import { OpenRouterError } from './openrouter';
import { getSetting, resolveApiKey } from './settings';

export const MEMORY_PROMPT =
  'Turn the following text into one short fact worth remembering about the user, written in the third person ' +
  '(for example "User lives in a small farming town."). If the text says nothing about the user, state its key ' +
  'point as a single short fact instead. Reply with the fact only.';

/** First non-empty line, without surrounding quotes, list markers or markdown emphasis, at most 300 characters. */
export function cleanFact(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line
    .replace(/^[-*#>\s"'`]+/, '')
    .replace(/["'`*\s]+$/, '')
    .slice(0, 300);
}

export async function suggestMemory(deps: Deps, text: unknown): Promise<string> {
  const { db, env, openrouter } = deps;
  const input = typeof text === 'string' ? text.trim() : '';
  if (!input) throw new HttpError(400, 'Nothing to remember.');
  const model = getSetting(db, 'memory_model_id') || getSetting(db, 'default_model_id');
  if (!model) throw new HttpError(400, 'Add a model in the Model Library first.');
  const { key } = resolveApiKey(db, env);
  if (!key) throw new HttpError(400, 'No OpenRouter API key set. Add one in Settings.');

  let raw: string;
  try {
    raw = await openrouter.complete({
      apiKey: key,
      model,
      // Reasoning models think before answering; a small budget is spent entirely on reasoning.
      maxTokens: 1000,
      messages: [
        { role: 'system', content: MEMORY_PROMPT },
        { role: 'user', content: input.slice(0, 4000) },
      ],
    });
  } catch (err) {
    throw new HttpError(502, err instanceof OpenRouterError ? err.message : 'Could not reach the memory model.');
  }
  const fact = cleanFact(raw);
  if (!fact) throw new HttpError(502, "The model didn't suggest anything. Type the fact yourself.");
  return fact;
}
```

- [ ] **Step 5: Add the route in `server/src/routes/memories.ts`**

Add the import `import { suggestMemory } from '../memorySuggest';` and change the function signature to take all deps: `export function memoryRoutes(deps: Deps): Hono {` with `const { db } = deps;` as its first line. Add before `r.patch('/:id', ...)`:
```ts
  r.post('/suggest', async (c) => {
    const { text } = await readJson<{ text?: unknown }>(c);
    return c.json({ suggestion: await suggestMemory(deps, text) });
  });
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run server/test/memorySuggest.test.ts` → Expected: 8 passed.
Run: `npm test` → Expected: all pass. Run: `npm run typecheck` → Expected: no errors (the web code reads `SettingsView` but never constructs one).

- [ ] **Step 7: Commit**

```bash
git add server shared
git commit -m "feat(server): suggest memory facts with a configurable memory model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web client plumbing — API calls and compare-mode state

**Files:**
- Create: `web/src/lib/compare.ts`, `web/src/lib/compare.test.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Consumes: Tasks 1–3 HTTP API and shared types.
- Produces:
  - `lib/compare.ts`: `interface CompareState { enabled: boolean; modelIds: string[] }`, `COMPARE_OFF`, `MAX_COMPARE = 4`, `parseCompareState(raw: string | null): CompareState`, `compareModels(state, libraryIds: string[]): string[] | null` (the ids to send, or null if not 2–4 valid), `toggleModel(state, id): CompareState`, `loadCompare(chatId): CompareState`, `saveCompare(chatId, state): void`
  - `api.ts`: `api.replies(chatId, parentId): Promise<Message[]>`, `api.suggestMemory(text): Promise<string>`, `streamComparison(url, body, h: CompareHandlers, signal): Promise<void>`, `interface CompareHandlers { onStart(e: CompareStart); onDelta(slot, text); onReasoning(slot, text); onSlotDone(e: CompareSlotDone); onSlotError(e: CompareSlotError); onDone(e: CompareDone); onError(e: StreamError); onTitle(e: StreamTitle) }`

- [ ] **Step 1: Write the failing test `web/src/lib/compare.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { COMPARE_OFF, compareModels, parseCompareState, toggleModel } from './compare';

describe('parseCompareState', () => {
  it('reads saved state and tolerates junk', () => {
    expect(parseCompareState('{"enabled":true,"modelIds":["a/1","b/2"]}')).toEqual({ enabled: true, modelIds: ['a/1', 'b/2'] });
    expect(parseCompareState(null)).toEqual(COMPARE_OFF);
    expect(parseCompareState('not json')).toEqual(COMPARE_OFF);
    expect(parseCompareState('{"enabled":"yes","modelIds":[1,"a/1","a/1"]}')).toEqual({ enabled: false, modelIds: ['a/1'] });
  });
});

describe('compareModels', () => {
  const library = ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'];
  it('returns the models to send when 2-4 valid ones are chosen', () => {
    expect(compareModels({ enabled: true, modelIds: ['a/1', 'c/3'] }, library)).toEqual(['a/1', 'c/3']);
  });
  it('ignores models no longer in the library and requires at least 2', () => {
    expect(compareModels({ enabled: true, modelIds: ['a/1', 'gone/x'] }, library)).toBeNull();
    expect(compareModels({ enabled: true, modelIds: [] }, library)).toBeNull();
  });
  it('returns null when compare is off', () => {
    expect(compareModels({ enabled: false, modelIds: ['a/1', 'b/2'] }, library)).toBeNull();
  });
});

describe('toggleModel', () => {
  it('adds and removes models, capped at 4', () => {
    const on = { enabled: true, modelIds: ['a/1'] };
    expect(toggleModel(on, 'b/2').modelIds).toEqual(['a/1', 'b/2']);
    expect(toggleModel(on, 'a/1').modelIds).toEqual([]);
    expect(toggleModel({ enabled: true, modelIds: ['a', 'b', 'c', 'd'] }, 'e').modelIds).toEqual(['a', 'b', 'c', 'd']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run web/src/lib/compare.test.ts`
Expected: FAIL — cannot resolve `./compare`.

- [ ] **Step 3: Create `web/src/lib/compare.ts`**

```ts
export interface CompareState {
  enabled: boolean;
  modelIds: string[];
}

export const COMPARE_OFF: CompareState = { enabled: false, modelIds: [] };
export const MAX_COMPARE = 4;

const storageKey = (chatId: string) => `openchat.compare.${chatId}`;

export function parseCompareState(raw: string | null): CompareState {
  try {
    const value = JSON.parse(raw ?? '');
    const ids = Array.isArray(value?.modelIds) ? value.modelIds.filter((id: unknown): id is string => typeof id === 'string') : [];
    return { enabled: value?.enabled === true, modelIds: [...new Set<string>(ids)].slice(0, MAX_COMPARE) };
  } catch {
    return COMPARE_OFF;
  }
}

/** The models a comparison should use, or null if compare is off or fewer than 2 chosen models are still in the library. */
export function compareModels(state: CompareState, libraryIds: string[]): string[] | null {
  if (!state.enabled) return null;
  const ids = state.modelIds.filter((id) => libraryIds.includes(id));
  return ids.length >= 2 && ids.length <= MAX_COMPARE ? ids : null;
}

export function toggleModel(state: CompareState, id: string): CompareState {
  if (state.modelIds.includes(id)) return { ...state, modelIds: state.modelIds.filter((m) => m !== id) };
  if (state.modelIds.length >= MAX_COMPARE) return state;
  return { ...state, modelIds: [...state.modelIds, id] };
}

export function loadCompare(chatId: string): CompareState {
  try {
    return parseCompareState(localStorage.getItem(storageKey(chatId)));
  } catch {
    return COMPARE_OFF;
  }
}

export function saveCompare(chatId: string, state: CompareState): void {
  try {
    localStorage.setItem(storageKey(chatId), JSON.stringify(state));
  } catch {
    // storage unavailable (private window); compare mode just won't be remembered
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run web/src/lib/compare.test.ts` → Expected: 6 passed.

- [ ] **Step 5: Update `web/src/api.ts`**

Extend the shared-types import to include `CompareDone, CompareSlotDone, CompareSlotError, CompareStart, Message`. Add to the `api` object, after `deleteChat`:
```ts
  replies: (chatId: string, parentId: string) =>
    json<Message[]>('GET', `/api/chats/${chatId}/replies?parentId=${encodeURIComponent(parentId)}`),
```
and after `deleteMemory`:
```ts
  suggestMemory: (text: string) => json<{ suggestion: string }>('POST', '/api/memories/suggest', { text }).then((r) => r.suggestion),
```
Replace `streamGeneration` and add `streamComparison`, sharing the request code:
```ts
/** POSTs to a generation endpoint; yields its SSE events, or reports an HTTP error through `onError`. */
async function postStream(url: string, body: unknown, signal: AbortSignal, onError: (e: StreamError) => void) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    onError({ message: data.error ?? `Request failed (${res.status})`, partial: null });
    return null;
  }
  return parseSSE(res.body);
}

/** Streams a single-model reply. Rejects with AbortError when `signal` aborts. */
export async function streamGeneration(url: string, body: unknown, h: StreamHandlers, signal: AbortSignal): Promise<void> {
  const events = await postStream(url, body, signal, h.onError);
  if (!events) return;
  for await (const ev of events) {
    const data = JSON.parse(ev.data);
    if (ev.event === 'start') h.onStart(data);
    else if (ev.event === 'delta') h.onDelta(data.text);
    else if (ev.event === 'reasoning') h.onReasoning(data.text);
    else if (ev.event === 'done') h.onDone(data);
    else if (ev.event === 'error') h.onError(data);
    else if (ev.event === 'title') h.onTitle(data);
  }
}

export interface CompareHandlers {
  onStart(e: CompareStart): void;
  onDelta(slot: number, text: string): void;
  onReasoning(slot: number, text: string): void;
  onSlotDone(e: CompareSlotDone): void;
  onSlotError(e: CompareSlotError): void;
  onDone(e: CompareDone): void;
  onError(e: StreamError): void;
  onTitle(e: StreamTitle): void;
}

/** Streams a comparison (body has `modelIds`). Rejects with AbortError when `signal` aborts. */
export async function streamComparison(url: string, body: unknown, h: CompareHandlers, signal: AbortSignal): Promise<void> {
  const events = await postStream(url, body, signal, h.onError);
  if (!events) return;
  for await (const ev of events) {
    const data = JSON.parse(ev.data);
    if (ev.event === 'start') h.onStart(data);
    else if (ev.event === 'delta') h.onDelta(data.slot, data.text);
    else if (ev.event === 'reasoning') h.onReasoning(data.slot, data.text);
    else if (ev.event === 'slot-done') h.onSlotDone(data);
    else if (ev.event === 'slot-error') h.onSlotError(data);
    else if (ev.event === 'done') h.onDone(data);
    else if (ev.event === 'title') h.onTitle(data);
  }
}
```

- [ ] **Step 6: Verify**

Run: `npm test` → all pass. Run: `npm run typecheck` → no errors. Run: `npm run build` → success.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "feat(web): API client for comparisons and memory suggestions; compare-mode state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Comparison UI — composer toggle, columns, choosing, compare versions

**Files:**
- Create: `web/src/components/ThinkingIndicator.tsx`, `web/src/components/CompareColumns.tsx`
- Modify: `web/src/components/Composer.tsx`, `web/src/components/MessageItem.tsx`, `web/src/components/ChatView.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: Task 4 (`api.replies`, `streamComparison`, `lib/compare`).
- Produces:
  - `ThinkingIndicator({ startedAt: number; reasoning: string })` (moved out of ChatView unchanged)
  - `interface Column { key: string; modelName: string; text: string; reasoning: string; startedAt: number; streaming: boolean; error: string | null; message: Message | null }`
  - `CompareColumns({ title?: string; columns: Column[]; onContinue?(messageId: string): void; onClose?(): void })`
  - `Composer({ disabledReason: string | null; streaming; models; modelId; onModelChange; compare: CompareState; onCompareChange(next: CompareState): void; onSend; onStop })`
  - `MessageItem` props change: `onRegenerate(modelId: string | null)` (null = compare with the chosen models), new `compareMode: boolean`, `onCompareVersions(): void`

**Behavior notes for the implementer:**
- `Pending` now holds `slots: SlotState[]` — one slot renders as the familiar single bubble, 2–4 slots render as live `CompareColumns`.
- After a comparison ends, `finish` reloads the chat; `detail.compare` then drives the "pick a reply" columns, and survives page reloads.
- `finish` only clears pending for its own chat, and runs if the stream closes without a final event (fixes two deferred review minors in passing).

- [ ] **Step 1: Create `web/src/components/ThinkingIndicator.tsx`**

Move the `ThinkingIndicator` function out of `ChatView.tsx` into its own file, exported:
```tsx
import { useEffect, useState } from 'react';

/** Shown until the first words arrive; reasoning models can think silently for 20+ seconds. */
export function ThinkingIndicator({ startedAt, reasoning }: { startedAt: number; reasoning: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="thinking">
      Thinking… {seconds}s
      {reasoning && (
        <details className="reasoning">
          <summary>Show reasoning</summary>
          <div className="reasoning-text">{reasoning}</div>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `web/src/components/CompareColumns.tsx`**

```tsx
import type { CSSProperties } from 'react';
import type { Message } from '../../../shared/types';
import { formatCost, formatTokens } from '../lib/format';
import { Markdown } from './Markdown';
import { ThinkingIndicator } from './ThinkingIndicator';

export interface Column {
  key: string;
  modelName: string;
  text: string;
  reasoning: string;
  startedAt: number;
  streaming: boolean;
  error: string | null;
  /** The saved reply, once there is one (complete or stopped). */
  message: Message | null;
}

interface Props {
  title?: string;
  columns: Column[];
  onContinue?(messageId: string): void;
  onClose?(): void;
}

export function CompareColumns({ title, columns, onContinue, onClose }: Props) {
  return (
    <div className="compare">
      {(title || onClose) && (
        <div className="compare-head">
          <span className="muted small">{title}</span>
          {onClose && <button className="link" onClick={onClose}>Close</button>}
        </div>
      )}
      <div className="compare-columns" style={{ '--cols': columns.length } as CSSProperties}>
        {columns.map((col) => {
          const m = col.message;
          const tokens = (m?.promptTokens ?? 0) + (m?.completionTokens ?? 0);
          return (
            <div key={col.key} className="compare-col">
              <div className="compare-model">{col.modelName}</div>
              {col.streaming && !col.text && <ThinkingIndicator startedAt={col.startedAt} reasoning={col.reasoning} />}
              {col.text && <div className="msg-body"><Markdown text={col.text} /></div>}
              {col.error && <div className="error-text small">{col.error}</div>}
              {m?.status === 'stopped' && !col.error && <div className="muted small">Response stopped</div>}
              {m && (
                <div className="msg-meta">
                  {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
                  {m.cost !== null && <span>· {formatCost(m.cost)}</span>}
                </div>
              )}
              {onContinue && m && (
                <button className="primary" onClick={() => onContinue(m.id)}>Continue with this one</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace `web/src/components/Composer.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { LibraryModel } from '../../../shared/types';
import { MAX_COMPARE, toggleModel, type CompareState } from '../lib/compare';

interface Props {
  /** Why sending is blocked right now, or null if it isn't. */
  disabledReason: string | null;
  streaming: boolean;
  models: LibraryModel[];
  modelId: string;
  onModelChange(id: string): void;
  compare: CompareState;
  onCompareChange(next: CompareState): void;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ disabledReason, streaming, models, modelId, onModelChange, compare, onCompareChange, onSend, onStop }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabledReason || streaming) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="Message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-models">
            <button
              className="toggle"
              aria-pressed={compare.enabled}
              disabled={models.length < 2}
              title="Send each message to several models and pick a reply"
              onClick={() => onCompareChange({ ...compare, enabled: !compare.enabled })}
            >
              Compare
            </button>
            {compare.enabled ? (
              <div className="compare-picker">
                {models.map((m) => {
                  const on = compare.modelIds.includes(m.id);
                  return (
                    <label key={m.id} className={`chip${on ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && compare.modelIds.length >= MAX_COMPARE}
                        onChange={() => onCompareChange(toggleModel(compare, m.id))}
                      />
                      {m.displayName}
                    </label>
                  );
                })}
              </div>
            ) : (
              <select value={modelId} onChange={(e) => onModelChange(e.target.value)} disabled={models.length === 0} aria-label="Model">
                {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
            )}
          </div>
          {streaming ? (
            <button className="primary" onClick={onStop}>Stop</button>
          ) : (
            <button className="primary" onClick={submit} disabled={!!disabledReason || !text.trim()}>Send</button>
          )}
        </div>
        {disabledReason && !streaming && <div className="composer-hint">{disabledReason}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update `web/src/components/MessageItem.tsx`**

Change the `Props` interface:
```tsx
interface Props {
  message: PathMessage;
  modelName: string;
  models: LibraryModel[];
  disabled: boolean;
  /** When on, Regenerate re-runs the comparison instead of offering a model list. */
  compareMode: boolean;
  onSelectSibling(id: string): void;
  /** null = regenerate with the compare models. */
  onRegenerate(modelId: string | null): void;
  onEdit(text: string): void;
  onCompareVersions(): void;
}
```
Destructure the new props (`compareMode`, `onCompareVersions`). In the assistant branch, replace the regenerate `<select ...>...</select>` with:
```tsx
        {compareMode ? (
          <button className="link" disabled={disabled} onClick={() => onRegenerate(null)}>↻ Compare again</button>
        ) : (
          <select
            className="regen"
            value=""
            disabled={disabled || models.length === 0}
            onChange={(e) => e.target.value && onRegenerate(e.target.value)}
            aria-label="Regenerate with model"
          >
            <option value="">↻ Regenerate</option>
            {regenerateChoices.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        )}
        {message.siblingIds.length > 1 && (
          <button className="link" disabled={disabled} onClick={onCompareVersions}>Compare versions</button>
        )}
```

- [ ] **Step 5: Replace `web/src/components/ChatView.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { ChatDetail, LibraryModel, Message, SettingsView } from '../../../shared/types';
import { api, streamComparison, streamGeneration } from '../api';
import { COMPARE_OFF, compareModels, loadCompare, saveCompare, type CompareState } from '../lib/compare';
import { formatCost } from '../lib/format';
import { initialModelId } from '../lib/models';
import { navigate } from '../lib/route';
import { CompareColumns, type Column } from './CompareColumns';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { MessageItem } from './MessageItem';
import { ThinkingIndicator } from './ThinkingIndicator';

export interface ChatViewProps {
  chatId: string | null;
  title: string;
  reloadToken: number;
  models: LibraryModel[];
  settings: SettingsView | null;
  onChatsChanged(): void;
}

interface SlotState {
  modelId: string;
  text: string;
  /** Live reasoning from models that think before answering; shown while pending, not saved. */
  reasoning: string;
  error: string | null;
  message: Message | null;
  done: boolean;
}

interface Pending {
  chatId: string;
  /** Number of detail.messages shown above the pending bubbles. */
  baseLength: number;
  /** Optimistic user bubble for send/edit; null for regenerate. */
  userText: string | null;
  startedAt: number;
  /** One slot for a normal reply, 2–4 for a comparison. */
  slots: SlotState[];
}

type RunOptions =
  | { kind: 'send'; text: string; baseLength: number; models: string[] }
  | { kind: 'regenerate'; parentId: string; baseLength: number; models: string[] }
  | { kind: 'edit'; messageId: string; text: string; baseLength: number; models: string[] };

export function ChatView({ chatId, title, reloadToken, models, settings, onChatsChanged }: ChatViewProps) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelId, setModelId] = useState('');
  const [compare, setCompareState] = useState<CompareState>(COMPARE_OFF);
  /** "Compare versions" view: the path index of the reply being compared, and all its versions. */
  const [versions, setVersions] = useState<{ index: number; replies: Message[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const viewChatRef = useRef<string | null>(chatId);
  const createdChatRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const messages = detail?.messages ?? [];
  const streaming = pending !== null;
  const libraryIds = models.map((m) => m.id);
  const compareList = compareModels(compare, libraryIds);
  const choosing = !pending && detail?.compare ? detail.compare : null;

  async function reload(id: string) {
    const next = await api.getChat(id);
    if (viewChatRef.current === id) setDetail(next);
  }

  function setCompare(next: CompareState) {
    setCompareState(next);
    if (chatId) saveCompare(chatId, next);
  }

  // Load the chat whenever the route (or an explicit reload request) changes.
  useEffect(() => {
    viewChatRef.current = chatId;
    if (chatId && chatId === createdChatRef.current) {
      createdChatRef.current = null; // we created this chat for an in-flight send; keep its stream
      return;
    }
    setError(null);
    setVersions(null);
    setPending((p) => (p && p.chatId === chatId ? p : null));
    setCompareState(chatId ? loadCompare(chatId) : COMPARE_OFF);
    if (!chatId) {
      setDetail(null);
      return;
    }
    reload(chatId).catch((e: Error) => setError(e.message));
  }, [chatId, reloadToken]);

  // New chats start on the default model; existing chats continue with the last model that replied.
  useEffect(() => {
    setModelId(initialModelId(messages, models));
  }, [detail, models]);

  // Keep the newest content in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail, pending?.baseLength]);
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [pending?.slots]);

  async function ensureChat(): Promise<string | null> {
    if (chatId) return chatId;
    try {
      const id = (await api.createChat()).id;
      createdChatRef.current = id;
      viewChatRef.current = id;
      saveCompare(id, compare);
      navigate(`#/chat/${id}`);
      onChatsChanged();
      return id;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  async function run(opts: RunOptions) {
    setError(null);
    setVersions(null);
    const streamChat = await ensureChat();
    if (!streamChat) return;
    const isShown = () => viewChatRef.current === streamChat;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending({
      chatId: streamChat,
      baseLength: opts.baseLength,
      userText: opts.kind === 'regenerate' ? null : opts.text,
      startedAt: Date.now(),
      slots: opts.models.map((id) => ({ modelId: id, text: '', reasoning: '', error: null, message: null, done: false })),
    });
    const updateSlot = (slot: number, change: (s: SlotState) => SlotState) => {
      if (!isShown()) return;
      setPending((p) => (p && p.chatId === streamChat ? { ...p, slots: p.slots.map((s, i) => (i === slot ? change(s) : s)) } : p));
    };

    const url = `/api/chats/${streamChat}/${opts.kind === 'send' ? 'messages' : opts.kind}`;
    const modelField = opts.models.length === 1 ? { modelId: opts.models[0] } : { modelIds: opts.models };
    const body =
      opts.kind === 'send' ? { content: opts.text, ...modelField }
      : opts.kind === 'regenerate' ? { parentId: opts.parentId, ...modelField }
      : { messageId: opts.messageId, content: opts.text, ...modelField };

    let settled = false;
    const finish = async (message: string | null) => {
      if (settled) return;
      settled = true;
      if (isShown()) {
        await reload(streamChat).catch(() => {});
        setPending((p) => (p?.chatId === streamChat ? null : p));
        setError(message);
      }
      onChatsChanged();
    };

    try {
      if (opts.models.length === 1) {
        await streamGeneration(url, body, {
          onStart: () => {},
          onDelta: (text) => updateSlot(0, (s) => ({ ...s, text: s.text + text })),
          onReasoning: (text) => updateSlot(0, (s) => ({ ...s, reasoning: s.reasoning + text })),
          onDone: () => { void finish(null); },
          onError: (e) => { void finish(e.message); },
          onTitle: () => onChatsChanged(),
        }, controller.signal);
      } else {
        const failures: string[] = [];
        await streamComparison(url, body, {
          onStart: () => {},
          onDelta: (slot, text) => updateSlot(slot, (s) => ({ ...s, text: s.text + text })),
          onReasoning: (slot, text) => updateSlot(slot, (s) => ({ ...s, reasoning: s.reasoning + text })),
          onSlotDone: (e) => updateSlot(e.slot, (s) => ({ ...s, message: e.message, done: true })),
          onSlotError: (e) => {
            failures.push(e.message);
            updateSlot(e.slot, (s) => ({ ...s, error: e.message, message: e.partial, done: true }));
          },
          onDone: (e) => { void finish(e.compareParentId ? null : `None of the models replied. ${failures[0] ?? ''}`.trim()); },
          onError: (e) => { void finish(e.message); },
          onTitle: () => onChatsChanged(),
        }, controller.signal);
      }
      if (!settled) void finish(null); // stream closed without a final event
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // The server saves partial replies when it notices the disconnect; give it a moment.
        setTimeout(() => { void finish(null); }, 400);
      } else {
        void finish((e as Error).message);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /** The models the next generation uses: the compare list, or the picked model. */
  const runModels = compare.enabled ? compareList : modelId ? [modelId] : null;

  const send = (text: string) => runModels && run({ kind: 'send', text, baseLength: messages.length, models: runModels });
  const regenerate = (index: number, model: string | null) => {
    const list = model ? [model] : compareList;
    if (list) run({ kind: 'regenerate', parentId: messages[index].parentId!, baseLength: index, models: list });
  };
  const edit = (index: number, text: string) =>
    runModels && run({ kind: 'edit', messageId: messages[index].id, text, baseLength: index, models: runModels });
  const retry = () => {
    const last = messages[messages.length - 1];
    if (!last || !runModels) return;
    if (last.role === 'user') run({ kind: 'regenerate', parentId: last.id, baseLength: messages.length, models: runModels });
    else run({ kind: 'regenerate', parentId: last.parentId!, baseLength: messages.length - 1, models: runModels });
  };
  const selectSibling = async (messageId: string) => {
    if (!chatId) return;
    try {
      setDetail(await api.selectMessage(chatId, messageId));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const continueWith = async (messageId: string) => {
    await selectSibling(messageId);
    setVersions(null);
  };
  const openVersions = async (index: number) => {
    if (!chatId) return;
    try {
      setVersions({ index, replies: await api.replies(chatId, messages[index].parentId!) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const nameOf = (id: string | null) => models.find((m) => m.id === id)?.displayName ?? id ?? '';
  const savedColumns = (replies: Message[]): Column[] =>
    replies.map((m) => ({ key: m.id, modelName: nameOf(m.modelId), text: m.content, reasoning: '', startedAt: 0, streaming: false, error: null, message: m }));

  const shown = pending ? messages.slice(0, pending.baseLength) : versions ? messages.slice(0, versions.index) : messages;
  const noKey = settings !== null && !settings.hasApiKey;
  const noModels = models.length === 0;
  // A user message at the end of the path means its reply was stopped or lost before any text arrived.
  const awaitingReply = !choosing && messages.length > 0 && messages[messages.length - 1].role === 'user';
  const wide = (pending !== null && pending.slots.length > 1) || choosing !== null || versions !== null;
  const disabledReason =
    noModels ? 'Add a model in the Model Library first.'
    : noKey ? 'Add your OpenRouter API key in Settings first.'
    : choosing ? 'Pick a reply to continue.'
    : compare.enabled && !compareList ? 'Choose 2 to 4 models to compare.'
    : null;

  return (
    <div className="chat">
      <header className="chat-header">
        <h1>{chatId ? title : 'New chat'}</h1>
        {detail && detail.chat.totalCost > 0 && <span className="muted small">Total {formatCost(detail.chat.totalCost)}</span>}
      </header>

      <div className="messages" ref={listRef}>
        <div className={`messages-inner${wide ? ' wide' : ''}`}>
          {(noKey || noModels) && (
            <div className="setup-hint">
              {noKey && <div>Add your OpenRouter API key in <a href="#/settings">Settings</a>.</div>}
              {noModels && <div>Add a model in the <a href="#/models">Model Library</a> to start chatting.</div>}
            </div>
          )}
          {!chatId && !pending && !noKey && !noModels && <div className="empty">How can I help you today?</div>}

          {shown.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              modelName={nameOf(m.modelId)}
              models={models}
              disabled={streaming || choosing !== null}
              compareMode={compareList !== null}
              onSelectSibling={selectSibling}
              onRegenerate={(model) => regenerate(i, model)}
              onEdit={(text) => edit(i, text)}
              onCompareVersions={() => openVersions(i)}
            />
          ))}

          {pending?.userText != null && (
            <div className="msg user"><div className="bubble">{pending.userText}</div></div>
          )}
          {pending && pending.slots.length === 1 && (
            <div className="msg assistant">
              {!pending.slots[0].text && <ThinkingIndicator startedAt={pending.startedAt} reasoning={pending.slots[0].reasoning} />}
              {pending.slots[0].text && <div className="msg-body"><Markdown text={pending.slots[0].text} /></div>}
              <div className="msg-meta"><span className="model-tag">{nameOf(pending.slots[0].modelId)}</span></div>
            </div>
          )}
          {pending && pending.slots.length > 1 && (
            <CompareColumns
              columns={pending.slots.map((s, i) => ({
                key: String(i), modelName: nameOf(s.modelId), text: s.text, reasoning: s.reasoning,
                startedAt: pending.startedAt, streaming: !s.done, error: s.error, message: s.message,
              }))}
            />
          )}
          {choosing && <CompareColumns title="Pick the reply to continue with" columns={savedColumns(choosing.replies)} onContinue={continueWith} />}
          {versions && !pending && (
            <CompareColumns title="All versions of this reply" columns={savedColumns(versions.replies)} onContinue={continueWith} onClose={() => setVersions(null)} />
          )}

          {error && !pending && (
            <div className="error-bubble">
              <span>{error}</span>
              {messages.length > 0 && <button onClick={retry} disabled={!runModels}>Retry</button>}
            </div>
          )}
          {!error && !pending && awaitingReply && (
            <div className="no-reply">
              <span className="muted">No reply yet. It was stopped before any text arrived.</span>
              <button onClick={retry} disabled={!!disabledReason}>Generate reply</button>
            </div>
          )}
        </div>
      </div>

      <Composer
        disabledReason={disabledReason}
        streaming={streaming}
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        compare={compare}
        onCompareChange={setCompare}
        onSend={send}
        onStop={() => abortRef.current?.abort()}
      />
    </div>
  );
}
```

- [ ] **Step 6: Add styles to `web/src/styles.css`**

Append:
```css
/* Comparison */
.messages-inner.wide { max-width: 1400px; }
.compare { display: flex; flex-direction: column; gap: 8px; }
.compare-head { display: flex; justify-content: space-between; align-items: center; }
.compare-columns { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 12px; }
.compare-col { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.compare-model { font-weight: 600; font-size: 13px; }
.compare-col > .primary { align-self: flex-start; margin-top: auto; }
@media (max-width: 900px) { .compare-columns { grid-template-columns: 1fr; } }
.composer-models { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; flex-wrap: wrap; }
.compare-picker { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; font-size: 13px; cursor: pointer; }
.chip.on { border-color: var(--accent); }
.chip input { margin: 0; }
button.toggle { padding: 4px 10px; font-size: 13px; }
button.toggle[aria-pressed='true'] { border-color: var(--accent); color: var(--accent); }
.composer-hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
```
Also change `.composer-bar select { max-width: 60%; }` to `.composer-bar select { max-width: 100%; }` (its container now limits it).

- [ ] **Step 7: Verify**

Run: `npm run typecheck` → no errors. Run: `npm run build` → success. Run: `npm test` → all pass.

- [ ] **Step 8: Commit**

```bash
git add web
git commit -m "feat(web): compare 2-4 models side by side and pick the reply to continue with

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: "Remember" button and the memory-model setting

**Files:**
- Create: `web/src/components/RememberBox.tsx`
- Modify: `web/src/components/MessageItem.tsx`, `web/src/pages/Settings.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: `api.suggestMemory`, `api.addMemory`, `SettingsView.memoryModelId`.
- Produces: `RememberBox({ text: string; onClose(saved: boolean): void })`

- [ ] **Step 1: Create `web/src/components/RememberBox.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';

/** Asks the memory model to condense `text` into a fact, lets the user edit it, and saves it to Memory. */
export function RememberBox({ text, onClose }: { text: string; onClose(saved: boolean): void }) {
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'suggesting' | 'ready' | 'saving'>('suggesting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.suggestMemory(text)
      .then((suggestion) => alive && setDraft(suggestion))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setState('ready'));
    return () => {
      alive = false;
    };
  }, [text]);

  async function save() {
    setState('saving');
    try {
      await api.addMemory(draft.trim());
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setState('ready');
    }
  }

  return (
    <div className="remember-box">
      {state === 'suggesting' ? (
        <span className="muted small">Suggesting a memory…</span>
      ) : (
        <>
          {error && <span className="error-text small">{error}</span>}
          <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type the fact to remember" autoFocus />
          <div className="row">
            <button onClick={() => onClose(false)}>Cancel</button>
            <button className="primary" disabled={!draft.trim() || state === 'saving'} onClick={save}>Save to memory</button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the Remember button to `web/src/components/MessageItem.tsx`**

Change the React import to `import { useRef, useState } from 'react';` and add `import { RememberBox } from './RememberBox';`. Inside the component, after the existing `useState` lines, add:
```tsx
  const [remembering, setRemembering] = useState<string | null>(null);
  const [rememberedNote, setRememberedNote] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef('');

  // Captured on mousedown, before the click can move focus: text highlighted inside this message, if any.
  const captureSelection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    selectionRef.current = text && sel?.anchorNode && bodyRef.current?.contains(sel.anchorNode) ? text : '';
  };
  const rememberButton = (
    <button className="link" onMouseDown={captureSelection} onClick={() => setRemembering(selectionRef.current || message.content)}>
      {rememberedNote ? 'Saved to memory' : 'Remember'}
    </button>
  );
  const rememberBox = remembering !== null && (
    <RememberBox
      text={remembering}
      onClose={(saved) => {
        setRemembering(null);
        if (saved) {
          setRememberedNote(true);
          setTimeout(() => setRememberedNote(false), 2000);
        }
      }}
    />
  );
```
In the user branch: add `ref={bodyRef}` to `<div className="bubble">`, add `{rememberButton}` after the Copy button inside its `msg-meta`, and add `{rememberBox}` right after that `msg-meta` div (inside the fragment).
In the assistant branch: add `ref={bodyRef}` to `<div className="msg-body">`, add `{rememberButton}` after the Copy button, and add `{rememberBox}` after the closing `</div>` of `msg-meta`.

- [ ] **Step 3: Add the setting to `web/src/pages/Settings.tsx`**

In the "Other" card, after the "Model for chat titles" `<label>`, add:
```tsx
          <label className="field">
            Model for memories
            <select value={view.memoryModelId} onChange={(e) => update({ memoryModelId: e.target.value })}>
              <option value="">Same as default model</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </label>
```

- [ ] **Step 4: Add styles**

Append to `web/src/styles.css`:
```css
.remember-box { width: min(600px, 80vw); display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.msg.assistant .remember-box { width: 100%; max-width: 600px; }
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → no errors. Run: `npm run build` → success. Run: `npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat(web): Remember button with AI-suggested memory facts; memory model setting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification with the real API key

**Files:** none (fix any defects found under superpowers:systematic-debugging, with a failing test first where testable).

Do not read `.env`. Do not delete any chats. Prefix every test prompt with `[OpenChat test]`. Remove any memory you add during testing. Run the updated server on a spare port so the user's running app is untouched:

```bash
OPENCHAT_PORT=3100 npx tsx server/src/index.ts
```
(after `npm run build`), and use the browser pane at `http://127.0.0.1:3100`.

- [ ] **Step 1:** New chat → Compare on → pick 3 models (include one reasoning model, e.g. GLM) → send. Expected: three columns stream independently, each with its own thinking timer; cost lines appear; "Pick the reply to continue with" appears; Send is disabled with "Pick a reply to continue."
- [ ] **Step 2:** Reload the page. Expected: the pick columns are still there.
- [ ] **Step 3:** Continue with the middle column. Expected: normal chat view with ‹ 2/3 › on the reply; Compare still on; send a follow-up → three new columns continue from the chosen reply.
- [ ] **Step 4:** In compare mode, press Stop while columns are mid-stream. Expected: columns with text become choosable "Response stopped" replies.
- [ ] **Step 5:** Turn Compare off. Expected: single picker preselects the chosen reply's model. Click **Compare versions** on a reply with several versions → columns of all versions; Close works; Continue switches the branch.
- [ ] **Step 6:** Auto-title appears after the first comparison.
- [ ] **Step 7:** Settings → Model for memories: pick a cheap model. On a user message, click Remember → suggested fact appears → edit → Save → it shows in Settings → Memory. Highlight part of an assistant reply, click Remember → suggestion is based on the highlight. Delete the test memories afterwards.
- [ ] **Step 8:** Run `npm test`, `npm run typecheck`, `npm run build`; stop the port-3100 server.
