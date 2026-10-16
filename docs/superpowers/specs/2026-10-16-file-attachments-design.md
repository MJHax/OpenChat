# File Attachments — Design Spec

**Date:** 2026-10-16
**Status:** Scope approved in conversation (pending spec review)
**Builds on:** `docs/superpowers/specs/2026-10-14-openchat-design.md` (which listed attachments as out of scope for v1), `docs/superpowers/specs/2026-10-14-compare-and-remember-design.md`

## Purpose

Attach files to user messages and have the model read them. Three kinds of file are supported:

| Kind | What counts | How the model gets it | Which models |
|---|---|---|---|
| **Image** | PNG, JPEG, WebP, GIF | `image_url` content part with a base64 data URL | Models whose `inputModalities` include `image` |
| **PDF** | `application/pdf` | `file` content part with a base64 data URL, plus OpenRouter's `file-parser` plugin | **Every model** (see "PDF engine") |
| **Text** | Any file that is valid UTF-8 with no NUL bytes: code, Markdown, CSV, JSON, logs, etc. | Read on the server and inlined into the message as text | **Every model** |

## Decisions made in conversation

- v1 formats: images, PDFs, text-like files.
- File bytes are stored as BLOBs in SQLite (deleted with their chat, no files on disk).
- When the model replying can't read an earlier attachment, the attachment is left out of the prompt and replaced with a short note. The chat itself is never changed.

## Out of scope

- Word, Excel, PowerPoint, audio and video files.
- OCR for scanned PDFs (the `mistral-ocr` engine costs money; see "PDF engine").
- Searching inside attachments (search stays on message text).
- Token or cost estimates before sending. Oversized prompts fail with the provider's error, as they do today.
- Attachments on assistant messages (models don't return files here).
- Reusing OpenRouter's parsed-PDF `annotations` between turns.

---

## Behavior

### Attaching

- The composer gets a **paperclip button** to the left of the model picker. It opens the system file picker (several files allowed).
- Files can also be **dropped** onto the composer or **pasted** into the textarea (pasted images from the clipboard included).
- Each file uploads immediately and appears as a **chip** above the textarea: a thumbnail for images, an icon for PDF and text, plus the file name, size and an **×** to remove it. A chip shows a spinner while uploading and its error if the upload is rejected (the chip stays until removed, so the reason is visible).
- **Send** is disabled while any upload is still running. A message may have attachments and no text.
- Limits (checked on the server, mirrored in the client so the error appears straight away):
  - Images: 5 MB each. PDFs: 20 MB each. Text files: 1 MB each.
  - At most 10 attachments and 30 MB in total per message.
  - Files that are none of the three kinds are rejected with "OpenChat can't read this file type yet. Images, PDFs and text files work."

### Sending an image to a model that can't view it

- If the selected model (or any checked model in Compare) doesn't accept images and the draft has an image, sending is blocked. The composer hint says "<Model> can't view images. Remove the image or pick another model." (or "Some of the compare models can't view images…").
- PDFs and text files never block sending; every model can read them.

### Earlier attachments and model switches

The whole active path is sent on every turn, so a chat may contain an image from an earlier turn when the user switches, regenerates or compares with a model that can't view images.

- In the prompt only, each such image becomes a text part: `[Image "photo.png" was attached here, but this model can't view images.]`
- Nothing in the database or the UI changes. Switching back to a model that can view images sends the image again.
- The composer shows a small notice when this applies to the next send: "Images earlier in this chat will be skipped for <Model>."

### Showing attachments in messages

- User bubbles show attachments above the text: image thumbnails (max 240 px tall), and file chips for PDF and text files. Clicking any attachment opens it in a new tab (`GET /api/attachments/:id`).
- **Copy** and **Remember** still use the message text only.

### Edit

- The edit box shows the message's attachments as chips with **×**, and has its own paperclip (plus drop and paste) for adding more.
- **Save & send** creates the new version with the resulting list. The original version keeps its own attachments.
- An edit may remove all text as long as at least one attachment remains (and the reverse).

### Regenerate, Compare, Retry

No new UI. These reply to an existing user message, so its attachments are already part of the path. In a comparison, each model gets a prompt built for its own capabilities (one may see the image while another gets the note).

---

## Data model

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,  -- NULL until the message is sent
  position INTEGER NOT NULL DEFAULT 0,                         -- order within the message
  kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id, position);
```

- **Pending uploads** have `message_id = NULL`. Sending a message claims them by setting `message_id` and `position`.
- **Cleanup.** Pending attachments older than 24 hours are deleted when the server starts and before each upload (uploads abandoned in a closed tab).
- **Edit copies** the kept attachments of the original into new rows for the new message (`INSERT … SELECT`, new ids). Each attachment belongs to exactly one message, so deleting a chat removes everything through the existing cascade. The cost is duplicate bytes when an attached message is edited, which is acceptable for a single-user app.
- `chats` deletion already cascades to `messages`, which now cascades to `attachments`.

```sql
-- models gets the capability data the composer and prompt builder need
ALTER TABLE models ADD COLUMN input_modalities TEXT;  -- JSON array, e.g. ["text","image","file"]
```

- Added through `migrate()` in `server/src/db.ts` when the column is missing.
- `addModel` stores `meta.inputModalities`.
- Rows with `NULL` (models added before this change) are filled from the cached catalog by `listLibrary`, which writes the value back. If the catalog isn't cached yet, the model is treated as `["text"]` until it is.

## Shared types

```ts
export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
}

// Message gains:
attachments: Attachment[];   // always present; [] for assistant messages and plain text

// LibraryModel gains:
inputModalities: string[];
```

`getChatMessages` loads attachment metadata (never `data`) in one extra query for the chat and groups it by message. `getMessage` does the same for its one message, so `insertMessage` and the `done` events return messages with their attachments.

---

## Server API

### Upload: `POST /api/attachments`

- `multipart/form-data` with one `file` field. Parsed with `c.req.parseBody()`, behind Hono's `bodyLimit` middleware set to 21 MB.
- **Kind detection, by content, never by extension or the browser's type:**
  - Image: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), GIF (`GIF87a`/`GIF89a`), WebP (`RIFF....WEBP`). The stored `mime` comes from the detected signature.
  - PDF: starts with `%PDF-`. `mime` is `application/pdf`.
  - Text: the whole file decodes with `new TextDecoder('utf-8', { fatal: true })` and contains no NUL bytes. `mime` is `text/plain`. A UTF-8 byte-order mark is stripped. (SVG and HTML files therefore count as text: the model sees their source and they are served back as plain text.)
  - Anything else: 400 with the "can't read this file type" message.
- Size limits per kind (above); 413 with "<name> is too large. The limit for <kind> files is <n> MB."
- `filename` is the uploaded name reduced to its last path segment, with control characters removed, at most 200 characters, and `file` if nothing is left.
- Response `201`: `Attachment`.

### `GET /api/attachments/:id`

Returns the bytes. Headers:
- `Content-Type`: the stored `mime` (`text/plain; charset=utf-8` for text).
- `X-Content-Type-Options: nosniff`
- `Content-Disposition: inline; filename*=UTF-8''<encoded name>`
- `Cache-Control: private, max-age=31536000, immutable` (attachments never change).

404 if missing.

### `DELETE /api/attachments/:id`

Only for pending attachments (the chip's **×**). Returns `{ ok: true }`. 409 "This file is already part of a message." if it has been sent; 404 if missing.

### Generation endpoints

- `POST /api/chats/:id/messages` accepts `attachmentIds?: string[]`.
- `POST /api/chats/:id/edit` accepts `attachmentIds?: string[]`: the **complete** list for the new version, in order. Each id is either a pending attachment or one belonging to the message being edited (that one gets copied).
- `content` may be empty when `attachmentIds` is non-empty. Both empty: 400 "Message is empty."
- Validation, before the chat is claimed for generation: at most 10 ids, no duplicates, each id exists and is allowed for this request (pending, or on the edited message). The total size is at most 30 MB. Failures are 400 "One of the attachments is no longer available. Remove it and attach it again." or the specific limit message.
- **Images and the selected models:** if any requested model doesn't accept images and the new attachments include an image, 400 "<Model> can't view images." (The UI blocks this first; the server check keeps the rule in one place.)
- The user message and the claim of its attachments are written in one transaction.
- `/regenerate` is unchanged.

---

## Prompt construction

`ChatMessage.content` becomes `string | ContentPart[]`:

```ts
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }                    // data:<mime>;base64,…
  | { type: 'file'; file: { filename: string; file_data: string } };     // data:application/pdf;base64,…
```

`buildMessages(persona, path, { inputModalities, loadAttachment })`:

- Messages without attachments are sent as a plain string, exactly as today, so prompts for plain chats don't change.
- A user message with attachments becomes parts in this order:
  1. The message text, if any.
  2. Each text file: `<file name="notes.md">\n…contents…\n</file>`
  3. Each image: an `image_url` part if `inputModalities` includes `image`, otherwise the note text part.
  4. Each PDF: a `file` part.
- Attachment bytes are loaded only for the path being sent, one message at a time, and are not cached between requests.
- Capabilities come from the model's library row. A model missing from the library is treated as `["text"]`.

### PDF engine

OpenRouter defaults to `mistral-ocr` (paid, $2 per 1,000 pages) for models without native file support. To avoid surprise charges, OpenChat always sets the engine when the prompt contains a PDF:

- Model's `inputModalities` include `file` → `plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }]` (billed as input tokens).
- Otherwise → `engine: 'cloudflare-ai'` (free; converts the PDF to Markdown text).

`streamChat` gains an optional `plugins` argument for this. Scanned PDFs with no text layer give little or nothing on `cloudflare-ai`. That limitation is accepted for v1.

### Comparison

`streamComparison` builds the prompt per slot (today it builds one shared prompt), so each model gets its own image handling and PDF engine.

### Titles and memory

`title.ts` keeps building a text transcript. A user message with attachments gets ` [attached: a.pdf, photo.png]` added to its line, so attachment-only first messages still get a sensible title. The memory suggester only receives message text and is unchanged.

---

## Web

- **`api.ts`:** `uploadAttachment(file, onProgress)` uses `XMLHttpRequest` for upload progress and resolves to `Attachment`. Also `deleteAttachment(id)` and `attachmentUrl(id)`.
- **`lib/attachments.ts` (new, pure, unit tested):** client-side kind guess and limit checks for instant errors, the "can send?" rule given draft attachments and model capabilities, and whether earlier path images will be skipped.
- **`components/AttachmentChips.tsx` (new):** the chip row, used by the composer and the edit box.
- **`Composer.tsx`:** paperclip, drop, paste, chips, and the blocked-send and skipped-images hints. `onSend(text, attachmentIds)`.
- **`MessageItem.tsx`:** renders attachments in user bubbles. The edit box gains chips and its paperclip. `onEdit(text, attachmentIds)`.
- **`ChatView.tsx`:** passes `attachmentIds` in the send and edit bodies. While a reply streams, the pending user bubble shows the attachments that were just sent.
- **Model Library:** the Vision and File input chips lose the "Not used by OpenChat yet" marker (from `2026-10-15-model-library-browse-design.md`). The Tools chip keeps it.

## Error handling summary

| Situation | Result |
|---|---|
| Unsupported file type | Upload 400; chip shows the message |
| Empty (0-byte) file | Upload 400 "<name> is empty."; chip shows the message |
| File over its size limit | 413 (client checks first); chip shows the message |
| More than 10 files or 30 MB in one message | Client refuses to add more; server 400 |
| New image, model can't view images | Send blocked with hint; server 400 if bypassed |
| Earlier image, model can't view images | Replaced in the prompt by a note; notice in composer |
| Attachment id missing or not allowed | 400 "One of the attachments is no longer available…" |
| Deleting an attachment that was sent | 409 |
| Provider rejects the content (too large, bad PDF) | Shown as a reply error, as today, through `friendlyError` |

## Testing

- **Server (Vitest, mocked OpenRouter):**
  - Upload: detects each image signature, PDF and UTF-8 text; rejects binary files, invalid UTF-8 and NUL bytes; enforces per-kind size limits; cleans file names; strips the BOM.
  - `GET` headers (type, nosniff, disposition) and 404; `DELETE` of pending vs. sent.
  - Pending cleanup deletes only unclaimed rows older than 24 hours.
  - `/messages` with attachments: claims them in order; empty text allowed with attachments; rejects unknown, duplicate, already-used and over-limit ids, all before claiming the chat.
  - New image with a text-only model is rejected; PDFs and text are allowed for any model.
  - `/edit` copies kept attachments, claims new ones, and leaves the original's untouched.
  - `buildMessages`: plain chats produce the same string prompts as today; part order; text-file wrapping; image vs. note by capability; PDF `file` part.
  - PDF engine: `native` for file-capable models, `cloudflare-ai` otherwise, no `plugins` without a PDF.
  - Comparison: each slot gets a prompt for its own model (one with the image, one with the note).
  - Deleting a chat removes its attachments.
  - Migrations: `models.input_modalities` added and backfilled from the catalog cache; the `attachments` table is created on old databases.
  - Title transcript includes attachment names.
- **Web:** unit tests for `lib/attachments.ts`.
- **Manual (browser pane, real key):** attach by button, drop and paste; send an image to a vision model; switch to a text-only model and confirm the notice and a sensible reply; a PDF with a text-only model (`cloudflare-ai`) and a file-capable model (`native`); a code file; edit a message to remove one attachment and add another; compare a vision and a text-only model on an image; reload and confirm attachments display; delete the chat.
