# File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach images, PDFs and text files to user messages, store them as SQLite BLOBs, and send each model a prompt it can read (images it can't view become a note; PDFs go through OpenRouter's `file-parser` with an engine OpenChat always picks).

**Architecture:** Files upload one at a time to `POST /api/attachments` and live as *pending* rows (`message_id NULL`) until a send or edit claims them. Messages carry attachment metadata; bytes are loaded only when building a prompt. `buildMessages` turns attachments into OpenAI-style content parts per model, using capability data now stored on library rows. The web client keeps a draft list of uploads per composer/edit box and sends `attachmentIds`.

**Tech Stack:** TypeScript, Hono 4 (server, `hono/body-limit`), better-sqlite3, React 19 + Vite (web), Vitest (`*.test.ts`, logic only — no component tests).

**Spec:** `docs/superpowers/specs/2026-10-16-file-attachments-design.md`

## Global Constraints

- Kinds: `image` (PNG, JPEG, WebP, GIF), `pdf`, `text` (valid UTF-8, no NUL bytes). Detected from content only, never the extension or browser type.
- Limits: image 5 MB, PDF 20 MB, text 1 MB each (MB = 1024 × 1024 bytes); at most 10 attachments and 30 MB total per message. Upload route `bodyLimit` 21 MB.
- Pending attachments older than 24 hours are deleted at server start and before each upload.
- Copy (exact):
  - Unsupported type: `OpenChat can't read this file type yet. Images, PDFs and text files work.`
  - Too large: `<name> is too large. The limit for <kind> files is <n> MB.` (`<kind>` is `image`, `PDF` or `text`)
  - Image note in prompts: `[Image "<filename>" was attached here, but this model can't view images.]`
  - Server image check: `<display name> can't view images.`
  - Composer, one model: `<display name> can't view images. Remove the image or pick another model.`
  - Composer, compare: `Some of the compare models can't view images. Remove the image or pick other models.`
  - Skipped notice: `Images earlier in this chat will be skipped for <display name>.`
  - Bad id: `One of the attachments is no longer available. Remove it and attach it again.`
  - Deleting a sent attachment: `This file is already part of a message.`
  - Empty message: `Message is empty.` (existing)
- Text files are inlined as `<file name="<filename>">\n<contents>\n</file>`.
- PDF engine: `native` when the model's `inputModalities` include `file`, else `cloudflare-ai`. Never omit the engine when a PDF is in the prompt; send no `plugins` when there is none.
- Plain chats (no attachments anywhere in the path) must produce exactly the same prompts as today: string `content`.
- Work on a branch (`feat/file-attachments`), not `main`.
- Use existing CSS variables only so light and dark themes both work.
- Verify every task with `npm test` and `npm run typecheck` from the repo root.

## Review Focus

- **Empty files.** A 0-byte upload (an empty `notes.txt`) is technically valid UTF-8, but sending it is pointless. Expected: 400 `<name> is empty.` Pinned in Task 2 (`detectKind` returns null for empty input) and Task 3 (route copy).
- **Text not in UTF-8.** A CSV saved by Excel in Windows-1252 (byte `0xE9` for "é") must be rejected with the unsupported-type copy, not stored as garbled text. Pinned in Task 2.
- **A send that fails after validation.** If the chat is busy (409) or the request is rejected, pending attachments must stay pending so the user can retry. Pinned in Task 5.
- **Regenerate with a text-only model.** Regenerating a reply to an image message with a model that can't view images must work (with the note), never 400. Only *new* images are blocked. Pinned in Task 6.
- **A model removed from the library mid-chat** (or a library row with `input_modalities` still NULL and no catalog cache) is treated as text-only, so its images become notes instead of a provider error. Pinned in Task 1 and Task 6.

---

## File Structure

| file | change | responsibility |
|---|---|---|
| `shared/types.ts` | modify | `AttachmentKind`, `Attachment`, `Message.attachments`, `LibraryModel.inputModalities` |
| `shared/attachments.ts` | create | limits, copy strings, `canViewImages` — used by server and web |
| `server/src/db.ts` | modify | `attachments` table, `models.input_modalities` migration |
| `server/src/catalog.ts` | modify | export cached modalities lookup |
| `server/src/library.ts` | modify | store/backfill modalities, `modelModalities` |
| `server/src/attachments.ts` | create | detection, storage, cleanup, resolving and claiming ids |
| `server/src/routes/attachments.ts` | create | upload, download, delete |
| `server/src/app.ts`, `server/src/index.ts` | modify | mount route; cleanup at start |
| `server/src/messages.ts` | modify | attach metadata to messages |
| `server/src/routes/generate.ts` | modify | `attachmentIds` on `/messages` and `/edit` |
| `server/src/prompt.ts` | modify | content parts, image notes, PDF plugin choice |
| `server/src/openrouter.ts` | modify | `plugins` on `streamChat`, union content type |
| `server/src/generate.ts`, `server/src/compare.ts` | modify | per-model prompt via one helper |
| `server/src/title.ts` | modify | attachment names in transcript |
| `server/test/appHelpers.ts` | modify | `upload` helper |
| `server/test/attachments.test.ts` | create | Tasks 2, 3, 5 tests |
| `web/src/lib/attachments.ts` (+ `.test.ts`) | create | client kind guess, limits, send-block and skipped-notice rules |
| `web/src/api.ts` | modify | upload with progress, delete, URL |
| `web/src/components/useAttachmentDraft.ts` | create | draft upload state shared by composer and edit box |
| `web/src/components/AttachmentChips.tsx` | create | chip row (draft and sent) |
| `web/src/components/Composer.tsx`, `MessageItem.tsx`, `ChatView.tsx` | modify | UI wiring |
| `web/src/lib/catalog.ts` | modify | Vision and File input marked used |
| `web/src/styles.css` | modify | chips, thumbnails, drop highlight |

---

### Task 1: Model capabilities on library rows

**Files:**
- Modify: `shared/types.ts` (`LibraryModel`), `server/src/db.ts` (`migrate`), `server/src/catalog.ts`, `server/src/library.ts`
- Test: `server/test/models.test.ts`, `server/test/db.test.ts`; update `LibraryModel` fixtures in `web/src/lib/models.test.ts`

**Interfaces:**
- Produces:
  - `LibraryModel.inputModalities: string[]`
  - `cachedModalities(db: DB): Map<string, string[]>` in `catalog.ts` (empty map when no cache row)
  - `modelModalities(db: DB, id: string): string[]` in `library.ts` — the library row's value, `['text']` when missing or unknown
  - `displayNameOf(db: DB, id: string): string` in `library.ts` — display name, or the id itself

- [ ] **Step 1: Write the failing tests** in `server/test/models.test.ts` (`describe('model library')`):
  - `'stores input modalities when a model is added'`: catalog fixture `google/gemini` gets `inputModalities: ['text', 'image', 'file']`; after `POST /api/models`, the listed model has `inputModalities: ['text', 'image', 'file']`. Update the existing `toEqual` in `'handles ids with slashes…'` to include `inputModalities: ['text']`.
  - `'backfills missing modalities from the cached catalog'`: add a model, `UPDATE models SET input_modalities = NULL`, then `GET /api/models` returns the catalog value and the row is no longer NULL.
  - `'treats unknown modalities as text-only'`: `modelModalities(db, 'not/in-library')` → `['text']`; a row with NULL and no cache row (`DELETE FROM model_catalog_cache`) → `['text']`.
  - In `db.test.ts`, `'adds input_modalities to an old models table'`: create a file DB whose `models` table lacks the column (raw `better-sqlite3`), `openDb` it, assert `PRAGMA table_info(models)` includes `input_modalities`.
- [ ] **Step 2: Run** `npx vitest run server/test/models.test.ts server/test/db.test.ts` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `migrate()` adds `ALTER TABLE models ADD COLUMN input_modalities TEXT` when missing (and the `CREATE TABLE` gets the column). `addModel` stores `JSON.stringify(meta.inputModalities)`. `listLibrary` fills NULL rows from `cachedModalities` and writes them back; rows still unknown report `['text']`. `cachedModalities` reuses `readCache`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS (fix the web `LibraryModel` fixtures the typecheck flags).
- [ ] **Step 5: Commit** — `feat(server): keep model input modalities on library rows`

### Task 2: Attachment storage and file detection

**Files:**
- Create: `shared/attachments.ts`, `server/src/attachments.ts`, `server/test/attachments.test.ts`
- Modify: `shared/types.ts`, `server/src/db.ts` (`SCHEMA`: the `attachments` table and index exactly as in the spec's Data model)

**Interfaces:**
- Produces in `shared/types.ts`: `type AttachmentKind = 'image' | 'pdf' | 'text'`; `interface Attachment { id: string; kind: AttachmentKind; filename: string; mime: string; size: number }`.
- Produces in `shared/attachments.ts`:
  - `MB = 1024 * 1024`; `ATTACHMENT_LIMITS: Record<AttachmentKind, number>` (5, 20, 1 MB); `MAX_ATTACHMENTS = 10`; `MAX_TOTAL_BYTES = 30 * MB`; `PENDING_TTL_MS = 24 * 60 * 60 * 1000`
  - `UNSUPPORTED_TYPE: string`, `tooLargeMessage(name: string, kind: AttachmentKind): string`, `emptyFileMessage(name: string): string` (`<name> is empty.`), `imageSkippedNote(filename: string): string`, `BAD_ATTACHMENT: string`
  - `canViewImages(inputModalities: string[]): boolean`
- Produces in `server/src/attachments.ts`:
  - `detectKind(bytes: Uint8Array): { kind: AttachmentKind; mime: string; bytes: Uint8Array } | null` — `bytes` has a UTF-8 BOM stripped for text; null for empty input and unsupported content
  - `cleanFilename(name: string): string`
  - `insertPending(db: DB, a: { filename: string; kind: AttachmentKind; mime: string; data: Uint8Array }): Attachment`
  - `getAttachmentRow(db: DB, id: string): (Attachment & { messageId: string | null }) | undefined`
  - `getAttachmentData(db: DB, id: string): Buffer | undefined`
  - `deletePending(db: DB, id: string): 'deleted' | 'sent' | 'missing'`
  - `cleanupPending(db: DB, olderThanMs?: number): number` (default `PENDING_TTL_MS`; returns rows deleted)
  - `attachmentsFor(db: DB, messageIds: string[]): Map<string, Attachment[]>` — ordered by `position`

- [ ] **Step 1: Write the failing tests** (`describe('detectKind')`, `describe('attachment storage')`):
  - PNG `89 50 4E 47 0D 0A 1A 0A …` → `{ kind: 'image', mime: 'image/png' }`; JPEG `FF D8 FF E0` → `image/jpeg`; `GIF89a` and `GIF87a` → `image/gif`; `RIFF????WEBPVP8 ` → `image/webp`; `%PDF-1.7` → `{ kind: 'pdf', mime: 'application/pdf' }`.
  - `'const x = "é";'` as UTF-8 → `{ kind: 'text', mime: 'text/plain' }`; with BOM `EF BB BF` the returned bytes start without it.
  - Rejects (null): empty `Uint8Array`, `[0x63, 0x00, 0x64]` (NUL), `[0x63, 0x61, 0x66, 0xE9]` (Windows-1252 "café"), random binary `[0x00, 0x01, 0x02, 0xFF]`.
  - `cleanFilename`: `'C:\\Users\\me\\notes.md'` → `'notes.md'`; `'a/b/c.txt'` → `'c.txt'`; `'bad\u0007name.txt'` → `'badname.txt'`; `''` → `'file'`; a 300-char name → length 200.
  - Storage: `insertPending` then `getAttachmentRow` has `messageId: null` and `size` = byte length; `getAttachmentData` returns the same bytes.
  - `deletePending`: pending → `'deleted'`; a row with `message_id` set → `'sent'`; unknown → `'missing'`.
  - `cleanupPending(db, 1000)`: deletes a pending row whose `created_at` is 2 s old, keeps a fresh pending row and an old claimed row.
  - Cascade: a row claimed by a message is gone after `deleteChat`.
- [ ] **Step 2: Run** `npx vitest run server/test/attachments.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the interfaces above. Text check: `new TextDecoder('utf-8', { fatal: true }).decode(bytes)` inside try/catch, plus `!bytes.includes(0)`. Signatures are checked before the text rule (so a PNG is never "text").
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): attachment storage and content-based file detection`

### Task 3: Attachment routes

**Files:**
- Create: `server/src/routes/attachments.ts`
- Modify: `server/src/app.ts` (mount at `/api/attachments`), `server/src/index.ts` (`cleanupPending(db)` after `openDb`), `server/test/appHelpers.ts`
- Test: `server/test/attachments.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `POST /api/attachments` (multipart field `file`) → 201 `Attachment`; 400 `UNSUPPORTED_TYPE` / `emptyFileMessage`; 413 `tooLargeMessage`; 400 `Attach a file.` when the field is missing.
  - `GET /api/attachments/:id` → bytes with the spec's headers; 404.
  - `DELETE /api/attachments/:id` → `{ ok: true }`; 409; 404.
  - Test helper `upload(app: Hono, bytes: Uint8Array | string, filename: string): Promise<Response>` in `appHelpers.ts` (builds `FormData` with a `File`; `makeApp` returns it bound as `upload`).

- [ ] **Step 1: Write the failing tests** (`describe('attachment routes')`):
  - Uploading `notes.md` with `'# Hi'` → 201 `{ kind: 'text', mime: 'text/plain', filename: 'notes.md', size: 4 }`.
  - A PNG named `photo.txt` → `kind: 'image'` (content wins over extension).
  - `GET` on it: `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Content-Disposition` contains `inline; filename*=UTF-8''photo.txt`, `Cache-Control: private, max-age=31536000, immutable`, body equals the bytes. A text file returns `text/plain; charset=utf-8`.
  - A 1 MB + 1 byte text file → 413 `notes.txt is too large. The limit for text files is 1 MB.`; a 5 MB + 1 PNG → 413 with `image` and `5 MB`.
  - Binary garbage → 400 with `UNSUPPORTED_TYPE`; empty file → 400 `empty.txt is empty.`
  - `DELETE` pending → 200 and `GET` now 404; `DELETE` on a claimed row → 409 `This file is already part of a message.`
  - An upload runs `cleanupPending`: a 25-hour-old pending row is gone after another upload.
- [ ] **Step 2: Run** `npx vitest run server/test/attachments.test.ts` — Expected: the route tests FAIL (404).
- [ ] **Step 3: Implement** with `bodyLimit({ maxSize: 21 * MB, onError: … 413 })` from `hono/body-limit`, `c.req.parseBody()`, and the Task 2 functions. Size is checked against `ATTACHMENT_LIMITS[kind]` after detection. `filename*` uses `encodeURIComponent`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): upload, download and delete attachments`

### Task 4: Messages carry their attachments

**Files:**
- Modify: `shared/types.ts` (`Message.attachments: Attachment[]`), `server/src/messages.ts`
- Test: `server/test/db.test.ts`; update `Message` fixtures flagged by the typecheck (`server/test/tree.test.ts`, web tests)

**Interfaces:**
- Consumes: `attachmentsFor` (Task 2).
- Produces: `getMessage` and `getChatMessages` return `attachments` (metadata only, `[]` when none). `insertMessage` returns `attachments: []` until Task 5 claims.

- [ ] **Step 1: Write the failing test** `'messages include their attachments in order'`: insert a user message, claim two pending rows for it with `position` 1 then 0 (direct `UPDATE`), and assert `getChatMessages(db, chatId)[0].attachments.map(a => a.filename)` follows position order and has no `data` key; an assistant message has `attachments: []`.
- [ ] **Step 2: Run** `npx vitest run server/test/db.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `messages.ts`: `getChatMessages` makes one `attachmentsFor` call for all ids; `getMessage` one call for its id.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): include attachment metadata on messages`

### Task 5: Sending and editing with attachments

**Files:**
- Modify: `server/src/attachments.ts`, `server/src/routes/generate.ts`
- Test: `server/test/attachments.test.ts` (`describe('sending with attachments')`)

**Interfaces:**
- Consumes: Tasks 1, 2, 4; `modelModalities`, `displayNameOf`.
- Produces in `server/src/attachments.ts`:
  - `resolveAttachmentIds(db: DB, ids: unknown, opts: { editedMessageId: string | null }): (Attachment & { messageId: string | null })[]` — throws `HttpError(400, BAD_ATTACHMENT)` for non-array, unknown, duplicate or not-allowed ids (allowed: pending, or `messageId === editedMessageId`); 400 when more than `MAX_ATTACHMENTS`; 400 `These files add up to more than 30 MB. Remove some and try again.` over `MAX_TOTAL_BYTES`. `undefined` → `[]`.
  - `attachToMessage(db: DB, messageId: string, list: (Attachment & { messageId: string | null })[]): void` — pending rows get `message_id` and `position`; rows owned by another message are copied (`INSERT … SELECT`, new id).
  - `requireViewable(db: DB, modelIds: string[], list: Attachment[]): void` — 400 `<display name> can't view images.` for the first model lacking `image` when `list` has an image.
- Changes in `routes/generate.ts`: `/messages` and `/edit` read `attachmentIds`; content may be empty when the list is non-empty; validation (`resolveAttachmentIds`, `requireViewable`) runs **before** `claim(chat)`; `insertMessage` + `attachToMessage` run in one `db.transaction`.

- [ ] **Step 1: Write the failing tests:**
  - Send with two uploads → the saved user message has both attachments in request order; their rows now have `message_id`.
  - Send with `content: ''` and one attachment → 200; with `content: ''` and no attachments → 400 `Message is empty.`
  - Unknown id, the same id twice, and an id already claimed by another message → 400 `BAD_ATTACHMENT`; 11 ids → 400.
  - Image with a library model whose modalities are `['text']` → 400 `Text Model can't view images.` (display name); a PDF and a text file with that model → 200. Comparison where one of two models lacks `image` → 400.
  - **Review Focus:** while a reply is in flight (409), the attachments sent with the rejected request are still pending (`getAttachmentRow(...).messageId === null`).
  - Edit keeping one of the original's two attachments and adding one new upload → new version has `[kept copy, new]` with a new id for the copy; the original message still lists its two.
  - Edit passing an attachment of a *different* message → 400 `BAD_ATTACHMENT`.
- [ ] **Step 2: Run** `npx vitest run server/test/attachments.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): send and edit messages with attachments`

### Task 6: Prompts with content parts and the PDF engine

**Files:**
- Modify: `server/src/prompt.ts`, `server/src/openrouter.ts`, `server/src/generate.ts`, `server/src/compare.ts`, `server/src/title.ts`
- Test: `server/test/prompt.test.ts`, `server/test/openrouter.test.ts`, `server/test/generate.test.ts`, `server/test/compare.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces in `prompt.ts`:
  - `type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'file'; file: { filename: string; file_data: string } }`
  - `ChatMessage.content: string | ContentPart[]`
  - `type Plugin = { id: 'file-parser'; pdf: { engine: 'native' | 'cloudflare-ai' } }`
  - `buildMessages(p: Persona, path: (Pick<Message, 'role' | 'content'> & { attachments?: Attachment[] })[], o?: { inputModalities: string[]; loadData(id: string): Buffer }): ChatMessage[]` — existing two-argument calls keep working
  - `pdfPlugins(path: { attachments?: Attachment[] }[], inputModalities: string[]): Plugin[] | undefined`
- Produces in `openrouter.ts`: `streamChat(o: { …; plugins?: Plugin[] })` — `plugins` added to the request body only when given.
- Produces in `generate.ts`: `promptFor(deps: Deps, chatId: string, parentId: string, modelId: string): { messages: ChatMessage[]; plugins?: Plugin[] }` — used by `streamReply` and by each slot in `streamComparison` (replacing the single shared prompt).

- [ ] **Step 1: Write the failing tests:**
  - `prompt.test.ts`: the existing tests pass unchanged. A user message with text `'Look'`, a text file `a.md` (`'# A'`), a PNG and a PDF, built with `['text','image']` → parts in order `text 'Look'`, `text '<file name="a.md">\n# A\n</file>'`, `image_url 'data:image/png;base64,…'`, `file { filename, file_data: 'data:application/pdf;base64,…' }`. Same with `['text']` → the image part becomes `text '[Image "photo.png" was attached here, but this model can't view images.]'`. Attachment-only message (empty text) → no empty text part. An assistant message stays a string.
  - `pdfPlugins`: no PDF → `undefined`; PDF + `['text','file']` → `[{ id: 'file-parser', pdf: { engine: 'native' } }]`; PDF + `['text']` → `cloudflare-ai`.
  - `openrouter.test.ts`: `streamChat` with `plugins` puts them in the posted JSON; without, the body has no `plugins` key.
  - `generate.test.ts`, **Review Focus:** regenerate a reply to an image message with a model whose library modalities are `['text']` → 200, and the recorded prompt has the note instead of an `image_url`. Same for a model not in the library.
  - `compare.test.ts`: compare a vision model and a text-only model on an image message → `calls` show one prompt with `image_url` and one with the note.
  - `generate.test.ts`: title transcript for a first message `''` with `report.pdf` contains `user:  [attached: report.pdf]` (record the `complete` call's messages).
- [ ] **Step 2: Run** `npm test` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Data URLs are `data:<mime>;base64,<Buffer.toString('base64')>`. `promptFor` loads persona, active path, `modelModalities` and `getAttachmentData`. Title lines append ` [attached: <names joined by ', '>]` when a message has attachments.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(server): send attachments to models as content parts`

### Task 7: Web attachment logic and API

**Files:**
- Create: `web/src/lib/attachments.ts`, `web/src/lib/attachments.test.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Consumes: `shared/attachments.ts`, `LibraryModel.inputModalities`, `Message.attachments`.
- Produces in `lib/attachments.ts`:
  - `guessKind(file: { name: string; type: string }): AttachmentKind` — `image/png|jpeg|webp|gif` → image; `application/pdf` or `.pdf` → pdf; anything else → text (the server decides for real)
  - `addError(existing: { size: number }[], file: { name: string; size: number; type: string }): string | null` — per-kind limit (`tooLargeMessage`), `MAX_ATTACHMENTS` (`You can attach up to 10 files.`), `MAX_TOTAL_BYTES` (same copy as the server's total message)
  - `sendBlockReason(kinds: AttachmentKind[], models: LibraryModel[]): string | null` — the two composer copies from Global Constraints; `models` is the model(s) that would reply
  - `skippedImagesNotice(path: { attachments: Attachment[] }[], models: LibraryModel[]): string | null` — the notice for the first model lacking `image` when any message in the path has an image
- Produces in `api.ts`: `uploadAttachment(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<Attachment>` (XMLHttpRequest; rejects with the server's `error` text), `deleteAttachment(id: string): Promise<void>`, `attachmentUrl(id: string): string`. `api` send/edit bodies are built in `ChatView`, so no change there.

- [ ] **Step 1: Write the failing tests** for the four functions, with the exact copy: `guessKind({ name: 'x.PDF', type: '' })` → `'pdf'`; `addError` at 10 files, at 30 MB total, and for a 6 MB PNG; `sendBlockReason(['image'], [textModel])` names the model; with two models one lacking → compare copy; `['pdf','text']` → null; `skippedImagesNotice` null when no images or every model can view them.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/attachments.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): attachment rules and upload API`

### Task 8: Attachment UI

**Files:**
- Create: `web/src/components/useAttachmentDraft.ts`, `web/src/components/AttachmentChips.tsx`
- Modify: `web/src/components/Composer.tsx`, `web/src/components/MessageItem.tsx`, `web/src/components/ChatView.tsx`, `web/src/lib/catalog.ts`, `web/src/styles.css`

**Interfaces:**
- Consumes: Task 7.
- Produces:
  - `interface DraftAttachment { key: string; name: string; size: number; kind: AttachmentKind; status: 'uploading' | 'ready' | 'error'; progress: number; error: string | null; attachment: Attachment | null; previewUrl: string | null }`
  - `useAttachmentDraft(initial?: Attachment[]): { items: DraftAttachment[]; add(files: FileList | File[]): void; remove(key: string): void; clear(): void; uploading: boolean; ids: string[]; kinds: AttachmentKind[] }` — `remove` on a pending upload calls `deleteAttachment`, but not for `initial` (sent) attachments; object URLs are revoked on remove/clear/unmount
  - `AttachmentChips({ items: DraftAttachment[] | Attachment[]; onRemove?(key: string): void })` — thumbnails (max 240 px tall in bubbles, small in drafts) for images, icon chips otherwise; sent items link to `attachmentUrl(id)` with `target="_blank"`
  - `Composer.onSend(text: string, attachmentIds: string[])`; `MessageItem.onEdit(text: string, attachmentIds: string[])`; `RunOptions` send/edit gain `attachments: Attachment[]` and bodies gain `attachmentIds`

- [ ] **Step 1: Build the hook and chips.** Paperclip button (hidden `<input type="file" multiple>`), `onDrop`/`onDragOver` on `.composer-box` with a `.dragging` highlight, and `onPaste` collecting `clipboardData.files`. `add` runs `addError` first and shows the error on the chip without uploading.
- [ ] **Step 2: Wire the Composer.** Send is disabled while `uploading`, and enabled with no text when at least one item is `ready`. The hint shows `sendBlockReason(kinds, replyModels)`, else `skippedImagesNotice(messages, replyModels)` (ChatView passes `messages` and the reply models: the compare list or the picked model). `submit` sends `ids` then `clear()`s without deleting.
- [ ] **Step 3: Wire MessageItem and ChatView.** User bubbles render `AttachmentChips` above the text. The edit box uses `useAttachmentDraft(message.attachments)`, its own paperclip/drop/paste, and Save & send needs text or attachments. The pending optimistic bubble shows the attachments just sent.
- [ ] **Step 4: Model Library.** Set `usedByOpenChat: true` for `vision` and `file` in `web/src/lib/catalog.ts`; update any `catalog.test.ts` assertion that expects them unused.
- [ ] **Step 5: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 6: Verify in the browser pane** (`preview_start` with the `.claude/launch.json` config, real key): attach by button, drop and paste; image to a vision model; switch to a text-only model and see the notice and a sensible reply; a PDF with a text-only and a file-capable model; a code file; edit to remove one attachment and add another; compare a vision and a text-only model on an image; reload and see attachments; dark mode; delete the chat. Check `read_console_messages` for errors and take a screenshot as proof.
- [ ] **Step 7: Commit** — `feat(web): attach files in the composer and edit box`
