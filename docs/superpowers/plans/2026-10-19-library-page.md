# Library Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-page **Library** (`#/library`) that lists every uploaded and generated file in two thumbnail-grid sections. From any file the user can download it, reuse it in a new chat, or open the chat(s) it is in.

**Architecture:**
- **Content hash.** A new `attachments.hash` column holds a SHA-256 of each file's contents. It lets the server group identical files and spot reuses.
- **Listing.** One server function, `libraryItems`, builds both sections from three sources: attachments, file blocks in assistant messages, and finished video clips. It is served at `GET /api/library`, next to a text route for chat-written files.
- **Page.** The web page groups, filters and previews the files.
- **Reuse.** "+ New chat" copies the file into a pending attachment, hands it to `App`, and lands on the new-chat composer with the file already attached.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, lucide-react, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-library-page-design.md`

## Global Constraints

- Full page in `.page-slot`, like `#/models` and `#/stats`. It is not an overlay.
- Its rail item sits right after Stats in `IconRail`.
- Sections are **Uploads** first, then **Generated**. Each heading shows "N files".
- Each section shows its **4** newest items. **See all** appears only when a section has **more than 4**.
- Type filters, in this order: **All / Images / Video / Docs / Code**. Search matches file names.
- There is no delete anywhere in the Library.
- Video tiles have no "+ New chat". Chats only accept image, PDF and text attachments.
- "Same file" means the same SHA-256 of the contents. Within a group the tile shows the newest copy, and its chat list holds each chat once, newest first.
- A user-message attachment whose hash matches any version of a generated file is a reuse. It adds its chat to that generated item and does not appear under Uploads.
- Newest first everywhere.

## Review Focus

These are the cases most likely to go wrong. Each one has a test in the task named in brackets.

- **Unsent pending uploads** (`message_id IS NULL`) must never appear. [Task 3]
- **Deleting a chat** removes its files from the Library. A group that was also in other chats stays, minus that chat. [Task 3]
- **Unfinished file blocks and clips are left out**: incomplete or streaming blocks, and clips that failed, are still rendering, or whose `.mp4` is missing. [Task 3]
- **The same upload twice in one chat** (branch copies made by `attachToMessage` or a fork) lists that chat once. [Task 3]
- **File names with spaces, slashes or unicode** round-trip through the chat-file text route. [Task 3]

---

## File map

| File | Change |
|---|---|
| `server/src/db.ts` | add the `hash` column, an index, and the backfill in `migrate` |
| `server/src/attachments.ts` | `hashBytes`, and set `hash` on every insert path |
| `server/src/fork.ts:27-30` | copy `hash` when forking |
| `shared/types.ts` | `LibraryItem`, `LibraryChatRef`, `LibraryResponse`, `LibraryFileType` |
| `shared/library.ts` (new) + `shared/library.test.ts` | `libraryType` |
| `server/src/fileLibrary.ts` (new) | `libraryItems`, `chatFileText` |
| `server/src/routes/library.ts` (new), `server/src/app.ts` | mount `/api/library` |
| `server/test/fileLibrary.test.ts` (new) | server tests |
| `web/src/lib/route.ts` (+ `route.test.ts`) | the `library` route |
| `web/src/components/shell/IconRail.tsx`, `web/src/lib/palette.ts`, `web/src/App.tsx` | rail item, palette entry, render, reuse handoff |
| `web/src/api.ts` | `api.library`, `libraryFileUrl`, `librarySrc` |
| `web/src/lib/fileLibrary.ts` (new) + test | filtering and section helpers |
| `web/src/lib/reuse.ts` (new) | turns an item into draft attachments |
| `web/src/components/ChatView.tsx`, `web/src/components/Composer.tsx` | accept a starting set of attachments |
| `web/src/pages/Library.tsx` (new), `web/src/components/library/*.tsx` (new), `web/src/styles/library.css` (new) | the UI |

---

### Task 1: Content hash on attachments

**Files:**
- Modify: `server/src/db.ts` (schema around lines 84-95, `migrate` around line 235)
- Modify: `server/src/attachments.ts` (`insertPending` :62, `attachToMessage` :110, `insertGenerated` :145)
- Modify: `server/src/fork.ts:27-30`
- Test: `server/test/attachments.test.ts`, `server/test/db.test.ts`

**Interfaces:**
- Produces: `hashBytes(data: Uint8Array): string`, exported from `server/src/attachments.ts`. It returns the SHA-256 as lowercase hex from `node:crypto` `createHash`.
- Produces: the `attachments.hash TEXT` column, which is non-null for every row after `openDb`, and the index `attachments_hash ON attachments(hash)`.

- [ ] **Step 1: Write the failing tests.** In `attachments.test.ts`, add a test `'stores a content hash on pending, generated, attached and copied rows'`:
  - `insertPending` a PNG, and assert `SELECT hash` equals `hashBytes(PNG)`.
  - `insertGenerated` the same bytes, and assert the same hash.
  - `attachToMessage` an already-claimed row onto a second message, which takes the copy path, and assert the new row has the same hash.

  In `db.test.ts`, add `'backfills hashes for attachments written before the column existed'`:
  - Open a file DB, insert a row, then `UPDATE attachments SET hash = NULL`. Close it, call `openDb` again, and assert the hash equals `hashBytes(data)`.
  - Follow the existing file-DB pattern in `db.test.ts`.

  Extend the fork test in `server/test/fork.test.ts` to assert that a forked attachment keeps its hash.
- [ ] **Step 2: Run them and check they fail.**
  Run: `npx vitest run server/test/attachments.test.ts server/test/db.test.ts server/test/fork.test.ts`
  Expected: FAIL. `hashBytes` is not exported, or `no such column: hash`.
- [ ] **Step 3: Implement.**
  - Add `hash TEXT` to the `CREATE TABLE` and `CREATE INDEX IF NOT EXISTS attachments_hash ON attachments(hash)`.
  - In `migrate`, add the column when it is missing. Then, for every row `WHERE hash IS NULL`, read `data` and set `hash = hashBytes(data)` inside one transaction.
  - Pass `hash` in `insertPending` and `insertGenerated`, and add it to the column list of both `INSERT … SELECT` copies (`attachToMessage` and `fork.ts`).
  - `db.ts` must not import from `attachments.ts`, because that would be circular. Put `hashBytes` in `db.ts` and re-export it from `attachments.ts`.
- [ ] **Step 4: Run the tests again and check they pass.** Same command. Expected: PASS. Also run `npm test`; the full suite should still be green.
- [ ] **Step 5: Commit.** `git commit -m "feat(server): content hash on attachments"`

---

### Task 2: Shared library types and file-type mapping

**Files:**
- Modify: `shared/types.ts` (near `GeneratedItems`, around line 505)
- Create: `shared/library.ts`, `shared/library.test.ts`

**Interfaces:**
- Produces, in `shared/types.ts`:
  ```ts
  export type LibraryFileType = 'image' | 'video' | 'doc' | 'code';
  /** One chat a library file is in; `at` is when it appeared there. */
  export interface LibraryChatRef { chatId: string; kind: ThreadKind; title: string; at: number }
  /** Where the file's bytes come from: a stored attachment, a file block a reply wrote, or a finished clip. */
  export type LibrarySource =
    | { type: 'attachment'; attachmentId: string; kind: AttachmentKind }
    | { type: 'chatFile'; messageId: string; name: string }
    | { type: 'video'; messageId: string };
  export interface LibraryItem {
    key: string;              // unique and stable: `att:<id>`, `file:<messageId>/<name>`, `video:<messageId>`
    type: LibraryFileType;
    name: string;
    size: number;             // bytes; for videos, the .mp4 size
    createdAt: number;        // newest `at` among `chats`
    source: LibrarySource;    // the newest copy (generated: the copy that was made)
    chats: LibraryChatRef[];  // each chat once, newest first; never empty
  }
  export interface LibraryResponse { uploads: LibraryItem[]; generated: LibraryItem[] }
  ```
- Produces: `libraryType(kind: AttachmentKind, name: string): Exclude<LibraryFileType, 'video'>` in `shared/library.ts`.
  - `image` maps to `'image'`.
  - `pdf` maps to `'doc'`.
  - `text` maps to `'doc'` when the extension, lowercased, is one of md, markdown, txt, rtf, csv, tsv, html, htm, log. Anything else is `'code'`.

- [ ] **Step 1: Write the failing test** `shared/library.test.ts`, named `libraryType`:
  - `('image','a.png') → 'image'`
  - `('pdf','r.pdf') → 'doc'`
  - `('text','notes.TXT') → 'doc'`
  - `('text','cover.md') → 'doc'`
  - `('text','page.html') → 'doc'`
  - `('text','parser.ts') → 'code'`
  - `('text','Makefile') → 'code'`
- [ ] **Step 2: Run it and check it fails.** Run `npx vitest run shared/library.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the types and `libraryType`.
- [ ] **Step 4: Run it again and check it passes.** Same command, then `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit.** `git commit -m "feat(shared): library item types"`

---

### Task 3: `libraryItems` and the `/api/library` routes

**Files:**
- Create: `server/src/fileLibrary.ts`, `server/src/routes/library.ts`, `server/test/fileLibrary.test.ts`
- Modify: `server/src/app.ts` (mount at `/api/library`, next to `/api/attachments`)

**Interfaces:**
- Consumes: `hashBytes` (Task 1), the `Library*` types and `libraryType` (Task 2), and `parseFileBlocks` and `fileVersions` from `shared/files.ts`.
  - It also uses `activePath` (`server/src/tree.ts`), `getChatMessages` (`server/src/messages.ts`), `clipPath(mediaDir, messageId)` (`server/src/videoJobs.ts`) and `Deps.mediaDir`.
- Produces: `libraryItems(db: DB, mediaDir: string): LibraryResponse`.
- Produces: `chatFileText(db: DB, messageId: string, name: string): string | undefined`. It returns the content of the last complete file block named `name` in that assistant message, the same lookup `copyGenerated` does.
- Produces these routes:
  - `GET /api/library` returns a `LibraryResponse`.
  - `GET /api/library/files/:messageId/:name` returns that file as `text/plain; charset=utf-8`, with `Content-Disposition: inline; filename*=UTF-8''…` built like `rfc5987` in `routes/attachments.ts`. Move that helper to `server/src/http.ts` so both routes share it. It returns 404 when `chatFileText` is undefined.

**Algorithm.** No metadata-only query loads `data`. Hashes come from the column, and file-block hashes are computed in memory.

1. **Generated groups, keyed by hash:**
   - **Images.** Attachments on `role='assistant'` messages in `chats.kind='image'`. Origin = that thread. Source = `attachment`.
   - **Chat files.** For every `chats.kind='chat'`:
     - Take the latest complete version of each file name along `activePath`, as `generatedItems` does. That version is the item, with source `chatFile`, its hash = `hashBytes(utf8(content))`, and origin = that chat at that message's `createdAt`.
     - Then hash every complete file block in every assistant message of the chat, on any branch, and map each of those hashes to the item for the same file name in that chat. This makes older versions count as reuses.
   - If two items share a hash, merge them into one: keep the newest as the source and take the union of their chats.
2. **User attachments.** These are attachments on `role='user'` messages, joined to their chat (id, kind, title) and the message's `created_at`.
   - When the hash is in the generated map, add the chat to that item.
   - Otherwise, group them into Uploads by hash. The newest row is the source; its `name` is the filename and its `size` the size.
3. **Videos.** Take each `video_jobs` row with `thread_id` set whose `clipPath(mediaDir, message_id)` exists. The item has type `'video'`, name `<thread title or "video">.mp4`, and size from `statSync`. Its chat is that thread, at the assistant message's `created_at`.
4. **Ordering.** Within each item, keep each chat once (the newest `at`) and sort chats newest first. `createdAt` is `chats[0].at`. Sort both lists by `createdAt` descending.

- [ ] **Step 1: Write the failing tests** in `server/test/fileLibrary.test.ts`. Seed with `openDb(':memory:')`, `createChat`, `insertMessage`, `insertPending` and `attachToMessage`, and use a temporary `mediaDir`. Write these tests:
  - `'lists a sent upload under uploads with its chat'`: `uploads[0]` matches `{ type: 'image', name: 'a.png', chats: [{ chatId }] }`, and `generated` is `[]`.
  - `'leaves out pending uploads'`: an unsent `insertPending` gives `uploads` `[]`.
  - `'groups identical uploads across chats, newest chat first, each chat once'`:
    - Send the same bytes in chats A, B and then C (later `created_at`), plus a branch copy in C.
    - Expect a single upload whose `chats.map(c => c.chatId)` is `[C, B, A]`.
    - Its `source.attachmentId` is C's row.
  - `'does not group uploads that only share a name'`: two different byte arrays named `x.txt` give 2 uploads.
  - `'lists generated images, chat files and finished videos'`:
    - An image-thread assistant image is type `'image'`.
    - A complete ```` ```ts file=parser.ts ```` block (use whatever fence syntax `shared/files.ts` parses) is `{ type: 'code', source: { type: 'chatFile', name: 'parser.ts' } }`.
    - A `video_jobs` row with an `.mp4` written to `clipPath` is `{ type: 'video', size: <bytes written> }`.
  - `'leaves out incomplete file blocks and unfinished clips'`: an unterminated block, and a `video_jobs` row with no file, both leave `generated` `[]`.
  - `'a reused generated file adds its chat to the generated item instead of uploads'`:
    - `copyGenerated` an image, then `attachToMessage` it in chat D.
    - The generated item's chats include the image thread and D, and `uploads` is `[]`.
  - `'an attached older version of a chat file counts as a reuse'`:
    - Chat E writes `notes.md` v1, then v2. Chat F attaches v1's bytes.
    - The item is v2 and its chats include F. `uploads` is `[]`.
  - `'identical files written in two chats collapse into one generated item'`.
  - `'deleting a chat removes it from every item'`:
    - Group the upload in A and B, then `deleteChat(A)`. The item's chats are `[B]`.
    - Delete B as well, and `uploads` is `[]`.
  - Route tests with `makeApp()`:
    - `GET /api/library` returns 200 and the shape above.
    - `GET /api/library/files/<id>/<encodeURIComponent('my notes/ü.md')>` returns 200 with the content and a `text/plain` content type.
    - An unknown name returns 404.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run server/test/fileLibrary.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `fileLibrary.ts` (following the algorithm above), `routes/library.ts`, and the mount in `app.ts`.
- [ ] **Step 4: Run the tests again and check they pass.** Same command, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(server): library listing and chat-file route"`

---

### Task 4: Route, rail item, palette and API client

**Files:**
- Modify: `web/src/lib/route.ts` and `route.test.ts`, `web/src/components/shell/IconRail.tsx`, `web/src/lib/palette.ts`, `web/src/App.tsx`, `web/src/api.ts`
- Create: `web/src/pages/Library.tsx` (a stub `<div className="page"><div className="page-inner"><h1>Library</h1></div></div>`, replaced in Task 6)

**Interfaces:**
- Produces the route `{ page: 'library' }` from `#/library`. `routeHash` maps it back.
- Produces the rail item `'library'`: label `Library`, lucide icon `Library`, imported as `LibraryIcon`. It goes right after Stats and navigates to `#/library`.
- Produces the palette entry `{ id: 'go-library', group: 'Go to', label: 'Library', keywords: 'files uploads downloads generated images videos' }`, and `'go-library': '#/library'` in `App.runCommand`.
- Produces these API helpers:
  - `api.library(): Promise<LibraryResponse>`
  - `libraryFileUrl(messageId: string, name: string): string`, which returns `/api/library/files/${messageId}/${encodeURIComponent(name)}`
  - `librarySrc(source: LibrarySource): string`, which is `attachmentUrl`, `libraryFileUrl` or `videoUrl` depending on the source type

- [ ] **Step 1: Write the failing tests** in `route.test.ts`:
  - `parseHash('#/library')` equals `{ page: 'library' }`.
  - `routeHash({ page: 'library' })` equals `'#/library'`.
  - If `settingsBackdrop` has a test table, add a case for it too.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run web/src/lib/route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Route, `routeHash`, rail item and palette entry.
  - In `App.tsx`: render `{page.page === 'library' && <Library … />}` in `.page-slot`, and extend `railActive` with `page.page === 'library' ? 'library'`.
  - The API helpers.
- [ ] **Step 4: Run the tests and typecheck, and check they pass.** Run `npx vitest run web/src/lib/route.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(web): library route and rail item"`

---

### Task 5: Library view helpers, reuse helper, and the new-chat handoff

**Files:**
- Create: `web/src/lib/fileLibrary.ts` + `fileLibrary.test.ts`, and `web/src/lib/reuse.ts`
- Modify: `web/src/App.tsx`, `web/src/components/ChatView.tsx` (prefill at :90 and :546), `web/src/components/Composer.tsx` (prefill at :37 and :49-56)

**Interfaces:**
- Produces, in `web/src/lib/fileLibrary.ts`:
  - `type TypeFilter = 'all' | LibraryFileType`
  - `TYPE_FILTERS: { id: TypeFilter; label: string }[]`, in the order All, Images, Video, Docs, Code
  - `SECTION_PREVIEW = 4`
  - `filterItems(items: LibraryItem[], query: string, type: TypeFilter): LibraryItem[]`. The query matches `name` case-insensitively after trimming, and an empty query matches everything.
  - `previewOf(items: LibraryItem[]): { shown: LibraryItem[]; more: boolean }`. It returns the first 4, and `more` is true when `items.length > 4`.
  - `canReuse(item: LibraryItem): boolean`, which is `item.type !== 'video'`
- Produces, in `web/src/lib/reuse.ts`: `reuseItem(item: LibraryItem): Promise<{ attachments: Attachment[]; files: File[] }>`. It mirrors `GeneratedPicker.attach`:
  - For an `attachment` source with kind `'image'`, fetch the blob. When `needsShrinking(blob.size)` holds, return a shrunk `File` (`shrinkImage`, named `<name without ext>.jpg`). Otherwise use `api.copyGenerated({ attachmentId })`.
  - Other `attachment` sources go through `api.copyGenerated({ attachmentId })`.
  - A `chatFile` source goes through `api.copyGenerated({ messageId, name })`.
- Produces a draft handoff:
  - `App` holds `startDraft: { attachments: Attachment[]; files: File[]; nonce: number } | null`.
  - `Library` gets `onReuse(d: { attachments; files })`. It sets `startDraft` with a nonce that goes up each time, then calls `navigate('#/')`.
  - `ChatView` gets `startDraft` (only when `page.chatId === null`) and `onStartDraftUsed()`. On a nonce change it calls `setPrefill(p => ({ nonce: (p?.nonce ?? 0) + 1, attachments, files }))` and then `onStartDraftUsed()`, which sets App's `startDraft` back to `null`.
  - `Composer`'s `prefill` type becomes `{ text?: string; attachments?: Attachment[]; files?: File[]; nonce: number }`. Its effect sets the text only when `text` is defined, then calls `draft.restore(attachments)` and `draft.add(files)` when they are present.
  - `SuggestionCards` keeps passing `text`.

- [ ] **Step 1: Write the failing tests** in `web/src/lib/fileLibrary.test.ts`:
  - `filterItems`:
    - The query `'PARS'` keeps `parser.ts` and drops `cover.md`.
    - Type `'doc'` keeps only docs.
    - `'all'` with `''` returns the input unchanged.
  - `previewOf`:
    - 4 items give `{ shown: 4, more: false }`.
    - 5 items give `{ shown: 4, more: true }`.
    - 0 items give `{ shown: [], more: false }`.
  - `canReuse`:
    - A video gives false.
    - Image, doc and code give true.
  - `TYPE_FILTERS.map(f => f.label)` equals `['All','Images','Video','Docs','Code']`.
- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run web/src/lib/fileLibrary.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `fileLibrary.ts`, `reuse.ts`, and the handoff through `App`, `ChatView` and `Composer`.
- [ ] **Step 4: Run the tests and typecheck, and check they pass.** Run `npx vitest run web/src/lib && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(web): library helpers and start-a-chat-with-files handoff"`

---

### Task 6: Library page UI

**Files:**
- Replace: `web/src/pages/Library.tsx`
- Create: `web/src/components/library/LibraryTile.tsx`, `ChatsBadge.tsx`, `LibraryPreview.tsx`, and `web/src/styles/library.css` (import it the same way `shell.css` and the other page CSS files are imported)

**Interfaces:**
- Consumes: `api.library`, `librarySrc`, `filterItems`, `previewOf`, `canReuse`, `TYPE_FILTERS`, `reuseItem`, `threadHref`, and `navigate`.
- `Library` props: `{ onReuse(d: { attachments: Attachment[]; files: File[] }): void }`.
- `LibraryTile` props: `{ item: LibraryItem; onOpen(): void; onReuse?(): void }`. `onReuse` is undefined for videos.
- `ChatsBadge` props: `{ chats: LibraryChatRef[] }`.
- `LibraryPreview` props: `{ item: LibraryItem; onReuse?(): void; onClose(): void }`.

**Behaviour:**
- **Header.** `<h1>Library</h1>`, then a search input (`type="search"`, `aria-label="Search files"`), then the type filters with the existing `Segmented` component from `components/stats/Segmented`. Put them in a header row styled like `.stats-head`.
- **Two-section view.**
  - Each section is a `<section>` with a heading, "Uploads" or "Generated", and a count. The count reads "1 file" or "N files" for the filtered items.
  - **See all** is a link button, shown only when `previewOf(...).more` is true.
  - The grid holds the `shown` tiles.
  - An empty section shows a muted line: "No uploads yet", "No generated files yet", or "Nothing matches" when a search or filter is active.
- **See-all view.** This is local state `expanded: 'uploads' | 'generated' | null`. Only that section shows, with every filtered item. A "← Back" link button returns to the two-section view. The search and filters stay applied.
- **Tile.**
  - Thumbnail:
    - Images use `<img loading="lazy" src={librarySrc}>`.
    - Videos use `<video preload="metadata" muted src={librarySrc}>` and a ▶ overlay.
    - Docs and code use the lucide `FileText` or `FileCode` icon, with the extension in uppercase.
  - Under the thumbnail: the filename, and the source chat.
    - With one chat, the chat line is the chat title as a link to `threadHref(kind, chatId)`.
    - With two or more, it is `<ChatsBadge>`, labelled "N chats ▾". It opens a popover listing each chat's title and date (`formatDate` or the existing date formatter in `lib/format`). Clicking a row navigates to that chat. The popover closes on outside click or Escape.
  - On hover or focus-within, the tile shows:
    - a **Download** button: an `<a href={librarySrc} download={item.name}>`
    - a **+ New chat** button, only when `onReuse` is set
  - Clicking the tile body opens `LibraryPreview`.
- **Preview.** A dialog built on the `.lightbox` styles. It shows:
  - the full `<img>`, or a `<video controls autoPlay>`, or the text fetched from `librarySrc`, or a PDF in an `<iframe>`
  - the name, Download, "+ New chat" (when allowed) and Close
  - Escape and a backdrop click both close it.
- **Reuse.** "+ New chat" calls `reuseItem(item)`, then `onReuse(result)`. Show the in-flight state on that button. If it fails, show the message in an `ErrorText` at the top of the page.
- **Layout.**
  - The grid is `repeat(auto-fill, minmax(160px, 1fr))`, and thumbnails are 120px high with `object-fit: cover`.
  - At phone width it drops to 2 columns, with no horizontal scroll.
  - Use the existing CSS tokens (colors and radii) from `shell.css` or `theme.css`. Don't add new colors.

- [ ] **Step 1: Implement** the page and components above.
- [ ] **Step 2: Typecheck and run the tests.** Run `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat(web): library page"`

---

### Task 7: Verify in the running app

- [ ] **Step 1: Start the app** with `preview_start` (add a `.claude/launch.json` entry that runs `npm run dev`, using the Vite port, if there isn't one).
- [ ] **Step 2: Check the page.**
  - The rail shows Library after Stats and opens `#/library`.
  - The page has two sections.
  - See all appears only with more than 4 items, and Back returns to both sections.
  - The type filters and search work.
- [ ] **Step 3: Check the actions.**
  - Upload the same image in two chats. The Library shows one tile with "2 chats ▾", and each row opens the right chat.
  - "+ New chat" on an image lands on the new-chat composer with the image attached.
  - A video tile has no "+ New chat", and its Download works.
  - The preview opens for an image, a video, a code file and a PDF.
- [ ] **Step 4: Check narrow width and dark mode** with `resize_window` set to mobile and to dark. Look for no horizontal scroll and readable tiles.
- [ ] **Step 5: Fix anything found** (each fix gets its own commit), and take a screenshot as proof.
