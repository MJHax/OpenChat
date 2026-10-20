# Saved Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Saved prompts window, opened from the rail or the chat composer, where the user keeps reusable prompts (with optional `{{slot}}` fields) and inserts them into the message box or starts a new chat with them.

**Architecture:** Prompts live in a new SQLite table behind `/api/prompts`, a copy of the memories route. Pure helpers in `web/src/lib/prompts.ts` parse and fill slots and work out the new-line insert. The window is App-level state (not a route) rendered over the page like Settings. App sends inserts to ChatView's Composer through a nonce'd `insert` prop, and sends new chats through the existing `startDraft` handoff, which gains a `text` field.

**Tech Stack:** Hono + better-sqlite3 (server), React 19 + lucide-react (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-saved-prompts-design.md`

## Global Constraints

- Neither action sends a message. Text only goes into the composer.
- Insert never replaces or reorders the user's draft, and the prompt always starts on its own line.
- Slot syntax is `{{name}}`, where the name is letters, digits, `_`, `-` and spaces, trimmed. The same name used twice is one field. An empty slot stays as the literal `{{name}}`.
- Opening the window must not unmount the chat behind it or reset its draft or attachments.
- Prompts are included in the data export and are cleared by "Delete all my data".
- Insert targets only the chat's main composer. It is disabled outside the chat page, and allowed while a reply streams.
- Rail position: after Library. Rail and composer icon: lucide `Bookmark`.

## Review Focus

1. **Brace text that isn't a slot** (`{{ user.name }}` in a Jinja snippet, `{{}}`, `{{{x}}}`) must stay literal and not produce fields. Pinned in Task 2.
2. **Inserting with the caret mid-line, at the start of a non-empty line, or right after a newline** must add exactly the line breaks needed, never a blank double break. Pinned in Task 2.
3. **Switching prompts or closing the window with unsaved edits** must not silently drop them. It asks "Discard changes?" first. Pinned in Task 4, step 3, checked by hand in Task 5.
4. **A composer that was never focused** (window opened from the rail on a fresh chat) must append at the end, not at position 0. Pinned in Task 3.
5. **"Delete all my data"** must also empty `saved_prompts`. Pinned in Task 1.

---

### Task 1: Prompt storage and API

**Files:**
- Modify: `server/src/db.ts` (schema string, after `memories`)
- Create: `server/src/routes/prompts.ts`
- Modify: `server/src/app.ts:60` (mount route)
- Modify: `server/src/dataStore.ts:65` (`ALL_TABLES`), `server/src/exportData.ts:80` (export)
- Modify: `shared/types.ts` (next to `Memory`), `web/src/api.ts:89-93`
- Test: `server/test/prompts.test.ts`, `server/test/dataRoutes.test.ts:132`, `server/test/export.test.ts`

**Interfaces:**
- Produces: `interface SavedPrompt { id: number; title: string; content: string; createdAt: number; updatedAt: number }` in `shared/types.ts`.
- Produces: `api.listPrompts(): Promise<SavedPrompt[]>`, `api.addPrompt(p: { title: string; content: string }): Promise<SavedPrompt>`, `api.updatePrompt(id: number, patch: { title?: string; content?: string }): Promise<SavedPrompt>`, `api.deletePrompt(id: number): Promise<{ ok: true }>`.
- Routes: `GET /api/prompts` (newest `updated_at` first, then `id` desc), `POST /` → 201, `PATCH /:id`, `DELETE /:id`. Title is trimmed and may be empty. Empty or whitespace content → 400 `'Prompt cannot be empty.'`. A missing id → 404 `'Prompt not found.'`.

- [ ] **Step 1: Write the failing tests** in `server/test/prompts.test.ts`, using `makeApp` from `./appHelpers`:
  - `supports create, list, edit and delete`: POST `{ title: ' Review ', content: '  Review {{file}} ' }` → 201, `{ title: 'Review', content: 'Review {{file}}' }`. PATCH `{ content: 'Check {{file}}' }` → content updated and `updatedAt >= createdAt`. GET → length 1. DELETE → 200, then GET → `[]`.
  - `lists the most recently updated first`: create A then B, PATCH A, GET → ids `[A, B]`.
  - `rejects empty content and unknown ids`: POST `{ title: 'x', content: '   ' }` → 400. PATCH `/api/prompts/999` → 404. DELETE `/api/prompts/999` → 404.
  - In `dataRoutes.test.ts`, add `'saved_prompts'` to the table list in `delete all my data…`, and insert a row first with `db.prepare("INSERT INTO saved_prompts (title, content, created_at, updated_at) VALUES ('', 'x', 1, 1)").run()`.
  - In `export.test.ts`, POST a prompt with content `'Bullets only'` and expect `data.prompts[0].content` to be `'Bullets only'`.

- [ ] **Step 2: Run** `npx vitest run server/test/prompts.test.ts server/test/dataRoutes.test.ts server/test/export.test.ts`. Expected: FAIL (404s, no such table).

- [ ] **Step 3: Implement.** Add the table `saved_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`. Write `promptRoutes(deps: Deps): Hono` modeled line for line on `routes/memories.ts`, and mount it at `/api/prompts`. Add `'saved_prompts'` to `ALL_TABLES` and `prompts: SELECT * FROM saved_prompts ORDER BY created_at, id` to the export `data`. Add the type and the `api.*` functions.

- [ ] **Step 4: Run** the same command, then `npm run typecheck`. Expected: PASS, no type errors.

- [ ] **Step 5: Commit** `feat: saved prompts storage and API`.

### Task 2: Slot and insert helpers

**Files:**
- Create: `web/src/lib/prompts.ts`, `web/src/lib/prompts.test.ts`

**Interfaces:**
- Produces:
  - `promptSlots(content: string): string[]`: unique slot names in order of first appearance.
  - `fillSlots(content: string, values: Record<string, string>): string`: an empty or missing value leaves `{{name}}` as written.
  - `insertOnOwnLine(value: string, caret: number, text: string): { value: string; caret: number }`: the caret is clamped to `[0, value.length]`, and the returned caret sits right after the inserted text (before any trailing break).
  - `promptLabel(p: SavedPrompt): string`: the title, or else the first non-empty line of the content, cut to 60 characters.
  - `matchesPrompt(p: SavedPrompt, query: string): boolean`: case-insensitive substring match on title or content. An empty query matches everything.
- Slot regex: `/\{\{\s*([A-Za-z0-9_\- ]*[A-Za-z0-9_\-][A-Za-z0-9_\- ]*)\s*\}\}/g`. The name is the trimmed capture, and `{{{x}}}` matches nothing (enforced by the test below; add a lookbehind and lookahead for `{` and `}` if the plain regex fails it).

- [ ] **Step 1: Write the failing tests:**
  - `promptSlots('Review {{file}} then {{ file }} and {{line no}}')` → `['file', 'line no']`.
  - `promptSlots('{{ user.name }} {{}} {{{x}}} {x}')` → `[]`.
  - `fillSlots('Review {{file}} and {{ file }} at {{line}}', { file: 'a.ts', line: '' })` → `'Review a.ts and a.ts at {{line}}'`.
  - `insertOnOwnLine('', 0, 'P')` → `{ value: 'P', caret: 1 }`.
  - `insertOnOwnLine('hello', 5, 'P')` → `{ value: 'hello\nP', caret: 7 }`.
  - `insertOnOwnLine('hello world', 5, 'P')` → `{ value: 'hello\nP\n world', caret: 7 }`.
  - `insertOnOwnLine('hello', 0, 'P')` → `{ value: 'P\nhello', caret: 1 }`.
  - `insertOnOwnLine('a\n', 2, 'P')` → `{ value: 'a\nP', caret: 3 }`.
  - `insertOnOwnLine('a\nb', 2, 'P')` → `{ value: 'a\nP\nb', caret: 3 }`.
  - `insertOnOwnLine('abc', 99, 'P')` → `{ value: 'abc\nP', caret: 5 }`.
  - `promptLabel` with title `''` and content `'\n  First line here\nsecond'` → `'First line here'`. `matchesPrompt` matches `'REVIEW'` against title `'Review'`, and against content when the title is empty.

- [ ] **Step 2: Run** `npx vitest run web/src/lib/prompts.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** the five functions in `web/src/lib/prompts.ts`.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat: slot filling and own-line insert for saved prompts`.

### Task 3: Composer insert path and new-chat text

**Files:**
- Modify: `web/src/components/Composer.tsx`, `web/src/components/ChatView.tsx`, `web/src/lib/reuse.ts` (type only), `web/src/App.tsx` (prop pass-through only)

**Interfaces:**
- Consumes: `insertOnOwnLine` (Task 2).
- Produces:
  - `ReuseDraft` gains `text?: string`. The ChatView `startDraft` effect passes `text: startDraft.text` into the prefill.
  - Composer gets new props `insert?: { text: string; nonce: number } | null` and `onOpenPrompts?(): void`.
  - ChatView gets new props `insert?: { text: string; nonce: number } | null` and `onOpenPrompts?(): void`, both passed straight to Composer.

- [ ] **Step 1: Composer remembers the caret.** Keep a `caretRef = useRef<number | null>(null)`, updated from `selectionEnd` in `onSelect` and `onBlur`. On a new `insert.nonce`, use `insertOnOwnLine(text, caretRef.current ?? text.length, insert.text)`, set the text, focus the textarea, and on the next animation frame set the selection to the returned caret, like the prefill effect does.
- [ ] **Step 2: Composer bookmark button.** When `onOpenPrompts` is set, render `<button className="icon-btn" aria-label="Saved prompts" title="Saved prompts">` with `<Bookmark size={15} />` after the web-search button.
- [ ] **Step 3: Wire it up.** Pass `insert` and `onOpenPrompts` through ChatView. In App, add `const [insertReq, setInsertReq] = useState<{ text: string; nonce: number } | null>(null)` and pass `insert={insertReq}` to ChatView (the window that sets it comes in Task 4).
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: composer can take an inserted prompt at the caret`.

### Task 4: Saved prompts window, rail icon and palette entry

**Files:**
- Create: `web/src/components/PromptsWindow.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/shell/IconRail.tsx`, `web/src/lib/palette.ts`, `web/src/styles/shell.css`

**Interfaces:**
- Consumes: the `api.*Prompt*` functions (Task 1), every helper in `lib/prompts.ts` (Task 2), `insertReq` and `startChatWith` in App (Task 3).
- Produces: `PromptsWindow({ canInsert, onInsert, onStartChat, onClose }: { canInsert: boolean; onInsert(text: string): void; onStartChat(text: string): void; onClose(): void })`.
- `RailItem` gains `'prompts'`. `IconRailProps` gains `onOpenPrompts(): void`. The palette gets `{ id: 'open-prompts', group: 'Go to', label: 'Saved prompts', keywords: 'snippets templates bookmarks' }`.

- [ ] **Step 1: App state.** Add `promptsOpen`. Include it in `overlayOpen`, so the page goes inert and focus is restored the way it already works. Set `canInsert = page.page === 'chat' && route.page !== 'settings'`. `onInsert` sets `insertReq` with the next nonce and closes the window. `onStartChat(text)` calls `startChatWith({ attachments: [], files: [], text })` and closes the window. Opening it from the rail, the composer button or the palette sets it to true. The rail shows `'prompts'` as active while it's open.
- [ ] **Step 2: Window shell.** Reuse the `.settings-overlay` and `.settings-sheet` markup and styles (a backdrop click closes it). Use `role="dialog" aria-label="Saved prompts"`. Copy the focus-on-mount and Escape-via-`closesOverlay` effect from `pages/Settings.tsx:44-54`. Add a `.prompts-sheet` modifier with a 240px list column. List rows use `.pop-item` styling and show the label, with a muted first line under it (ellipsis).
- [ ] **Step 3: Behaviour:**
  - Load with `api.listPrompts()` and filter with `matchesPrompt`.
  - **＋ New** opens an empty editor (a Title input and a Content textarea) with Save and Cancel. Edit opens the same editor on the selected prompt. Save calls add or update, re-sorts by moving the saved prompt to the top, and selects it. API errors show through `ErrorText`.
  - While the editor has unsaved changes, picking another prompt, ＋ New, close or Escape first asks `window.confirm('Discard changes?')`.
  - Delete asks `` window.confirm(`Delete "${promptLabel(p)}"?`) ``.
  - The detail pane shows one labeled input per `promptSlots(content)`, with values reset when the selection changes. The text sent by Copy (`navigator.clipboard.writeText`), Start new chat and Insert into message (primary) is `fillSlots(content, values)`.
  - When `!canInsert`, Insert into message is disabled with `title="Open a chat to insert into its message box."`.
  - With no prompts, show an empty state with the text "No saved prompts yet." and a ＋ New button.
- [ ] **Step 4: Rail and palette.** Add `item('prompts', 'Saved prompts', Bookmark, onOpenPrompts)` after Library. Handle `'open-prompts'` in `runCommand`.
- [ ] **Step 5: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: saved prompts window`.

### Task 5: Verify in the browser

- [ ] **Step 1:** Start the `dev` preview from `.claude/launch.json`. Check the console and server logs for errors.
- [ ] **Step 2:** Create a prompt with `{{file}}`. In a chat, type `hello world`, put the caret after `hello`, open the window from the composer button, fill the slot and click Insert. The box should read `hello\n<prompt>\n world`, focused, with the caret after the prompt.
- [ ] **Step 3:** Open the window from the rail on the Images page. Insert is disabled with its tooltip. Start new chat lands on `#/` with the filled text in the box and nothing sent.
- [ ] **Step 4:** Edit a prompt, then press Escape and confirm the discard prompt appears. Check the empty state, search, and delete. Check that the chat's draft and attachments are still there after closing the window.
- [ ] **Step 5:** Check light and dark mode, and a 375px-wide window (the sheet stacks the list over the detail, like Settings). Take a screenshot as proof.
