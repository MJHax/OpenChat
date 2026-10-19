# Library page: design

## Why

Files the user uploads, and files OpenChat generates, are scattered across many chats. Right now the only way to find one is to remember which chat it was in. The Library collects all of them on one page so the user can find a file and then do something with it: download it, reuse it in a new chat, or jump back to the chat it came from.

## Goals

- A **Library** page that lists every uploaded and every generated file.
- From any file the user can:
  - **download** it
  - **reuse** it, which starts a new chat with the file already attached
  - **open the chat it came from**
- When the same file was uploaded to several chats, the user can see all of those chats and pick one to open.

## Non-goals

- **Deleting files.** The user decided that deleting the chat is enough. The Library has no delete action, and no single-file delete endpoint gets added.
- Changing how files are stored. The `attachments` BLOBs and the video files on disk stay as they are.
- Sharing files, renaming them, or organizing them into folders or tags.

## Anti-goals

These would make the feature a failure even if it technically works:

- Generated content buried under a long wall of uploads. This is why each section is capped at 4 items (see below).
- A page that looks or behaves differently from Model Library and Stats.

## Decided by the user

- **Placement:** a new **Library** item in the icon rail, grouped with Model Library and Stats (`web/src/components/shell/IconRail.tsx:50-51`).
- **Page type:** a full page in `.page-slot`, like `#/models` and `#/stats`. It is not an overlay like Settings. Suggested route: `#/library`.
- **Layout:** the thumbnail grid (mockup option A). There are two sections on the same page, **Uploads** first and **Generated** second. Each section heading shows its file count, for example "14 files".
- **Overflow:** each section shows its 4 newest files. When a section has more than 4, a **See all** link appears next to the count. Clicking it switches the page to show only that section with all of its files, plus a way back to the two-section view.
- **Top bar:** a search box, which matches file names, and type filters: All / Images / Video / Docs / Code.
- **Tile:**
  - a thumbnail and the filename
  - the source chat's title, which is a link that opens that chat
  - on hover, a **Download** button and a **+ New chat** button
- **Same file in several chats:** the tile shows one entry with a "**N chats ▾**" badge. Clicking the badge lists those chats with their titles and dates, and picking one opens it.
- **Badge on Generated tiles too:** a Generated tile's chat list includes the chat that made the file plus every chat it was reused in. Reusing it in a new chat or attaching it by hand both count. Grouping by hash therefore runs across both sections.
- **Click a tile:** opens a larger preview, which shows the full image, a playing video, or the text of a doc or code file. Download and + New chat are available from the preview too.
- **What counts as Generated:**
  - images made in image threads
  - videos made in video threads
  - the files models write in chats: fenced file blocks parsed by `shared/files.ts`, the latest version of each file in each chat, as `generatedItems` already does
- **Videos can't be reused:** chats only accept image, PDF and text attachments, so video tiles have no **+ New chat**. They still offer Download and open-chat.

## Builder's calls (made during brainstorming, not confirmed by the user)

- **"Same file"** means identical contents, compared with a content hash. A matching filename alone doesn't count. Within a group, the tile represents the newest copy.
- **Uploads** are attachments on `role = 'user'` messages, in any thread kind. One exception: an attachment whose contents match a generated file is a reuse, not a new upload, so it doesn't appear under Uploads.
- **Reuse detection covers every version of a chat-written file**, not only the latest one. If an older version is attached later, it still counts as a reuse of that generated file and doesn't show up as an upload. These are small text blobs, so hashing them all is cheap.
- **Identical generated files from different chats** collapse into one Generated tile. That tile carries the badge listing every one of those chats.
- **The same file twice in one chat**, for example branch copies made by `attachToMessage`, counts as that chat once.
- **Search and type filters** apply to both sections and also to the See-all view.
- **Type mapping:**
  - Images: image attachments and generated images
  - Video: generated videos
  - Docs: PDFs, plus text files with doc extensions (md, txt, html, docx-like)
  - Code: everything else that is text
  - The builder picks the exact extension lists.
- **Sorting:** newest first.

## How it fits the existing code

- **Serving:** files are served by `GET /api/attachments/:id` and `GET /api/videos/:messageId`. Chat-written files have no server route. They are downloaded in the browser as a Blob, the way `FileCard.saveBlob` does it, or through a new route if the builder prefers.
- **Reuse:**
  - `api.copyGenerated({attachmentId} | {messageId, name})` already makes a pending copy that can be attached. Plain uploads can use the `attachmentId` form too.
  - The new chat needs that attachment in its composer draft. The draft lives in `Composer` / `useAttachmentDraft`, so the pending attachment has to reach the new-chat composer through `draft.restore(...)`. A small piece of app-level state or a prop is enough; the builder chooses.
- **Opening a chat:** `openChat(chatId, kind)` / `threadHref` in `web/src/lib/route.ts`.
- **Hashing:** content hashing needs a stored hash, so the builder doesn't rehash every BLOB on every request. Adding a `hash` column to `attachments` with a one-time backfill is the expected approach. Chat-written files can be hashed on the fly because they are small text.
- **Paging:** the list endpoint should return enough for See all without loading BLOB data. Metadata only; thumbnails are loaded by URL.

## Left to the builder

- The API shape of the new list endpoint or endpoints.
- How the composer draft gets pre-filled when starting a new chat from the Library.
- Thumbnail rendering for non-image files: icons, a text snippet, or a video poster frame.
- The empty states, and the preview component, which can reuse existing preview pieces if any fit.
- Tests in line with the existing server and web test setup.
