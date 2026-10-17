# File Generation in Chat — Design Spec

**Date:** 2026-10-17
**Status:** Decisions approved in conversation (pending spec review)
**Builds on:** `2026-10-14-openchat-design.md`, `2026-10-14-compare-and-remember-design.md`, `2026-10-16-file-attachments-design.md`, `2026-10-16-web-search-design.md`

This is project 1 of 3. Project 2 is an **Images** sidebar tab and project 3 is a **Video** tab. Both get their own specs; this one does not depend on them.

## Purpose

Let a chat model hand the user a file to look at, use and keep. The user's example: "make me an HTML page that graphically compares the top AI models right now." The model searches the web (existing feature), writes the page, and OpenChat shows it running live next to the chat with a Download button. Other examples: a brochure or a month's schedule, printed to PDF.

## Decisions made in conversation

- **The harness makes files, not the model.** Any model can produce a file. There is no special "file model."
- **Marked blocks, not tool calls.** The system prompt teaches the model to wrap each file in `<file name="…">…</file>` in its normal reply. OpenChat pulls those blocks out of the text and shows them as files. The user chose this over a real `create_file` tool because it costs one request, not two (a tool call needs a second request that resends the whole file). It also streams as the model writes, and it works on every model, so there is no "no files" marking in the model picker and no "this model can't make files" note.
- **File card + side panel (mockup option B).** The reply holds a small file card. Clicking it opens the file live in a panel beside the chat, with Download. The user rejected an inline preview (A) and a full-screen viewer (C).
- **Both interactive and download:** HTML runs live in the panel and is also downloadable.
- **PDF = "Print / Save as PDF" through the browser's print dialog.** There is no server-side Chromium for now ("it's a bit much"), but this may be revisited later.
- **Pictures for a brochure come from the user**, made separately (later, in the Images tab). The model doesn't generate pictures from chat. The user attaches the image to the chat and the model places it in the page.
- **A "Save as file" button on large code blocks** covers models that forget the format and paste plain code.

## Out of scope

- Server-side PDF rendering, .docx, .xlsx, .pptx, and any code-execution sandbox.
- Real tool calls / a client tool loop.
- Generating images from the chat. The Images tab (project 2) is separate.
- A gallery of all files across chats.
- Editing a file by hand in the panel.

---

## The format

The system prompt always gets a short file section (about 150 tokens; the exact wording is the builder's call), which says:

- When the user asks for a file, or when the content is a standalone document they'll want to keep or view (a web page, an SVG, a CSV, a long Markdown document, a script), put it in `<file name="name.ext">` … `</file>`. The opening and closing tags each go on their own line, with raw content in between and no code fence.
- Use a short, descriptive file name with the right extension.
- To change a file, write the **whole** file again under the **same name**. That makes a new version.
- HTML must be one self-contained file. It may load libraries from public CDNs (for example Chart.js from cdnjs or jsDelivr). Images the user attached to the chat can be used by file name, for example `<img src="beach.jpg">`. The section lists the names of attached images in the chat.
- For pages meant to be printed or saved as PDF, use print CSS (`@page` size, page breaks).
- Don't paste the file's content again outside the block. A sentence or two about it is enough.

`buildSystemPrompt` currently returns `null` when the persona is empty. From now on, the reply prompt always has a system message. Title generation and memory suggestions don't get the file section.

The tag matches how text attachments are already sent *to* the model (`<file name="…">` in `prompt.ts`), so files look the same in both directions.

## Parsing

- A shared parser (in `shared/`, so web and server agree) splits an assistant message's `content` into text segments and file blocks: `{ name, content, complete }`.
- An opening tag must start a line. The parser tolerates one code fence wrapped around a whole block (some models will add one anyway) and strips it.
- An unclosed block at the end of the text is a file that's still being written (`complete: false`). While streaming, that means "writing." On a saved message (stopped or error), it means the file was cut off.
- Only **assistant** messages are parsed. User messages keep showing `<file>` text as typed.
- **Storage: none new.** Files live in the message's `content`, exactly as the model wrote them. No new table, no migration, and search (FTS) finds text inside files for free. Deleting a chat deletes its files.

## In the chat

- Each file block renders as a **file card** where the block was in the text: a type icon (HTML, SVG, MD, CSV, code, other), the file name, the size, a version label when it's v2+, and a Download button. Clicking the card opens the panel.
- **While streaming**, the card shows `Writing ai-model-comparison.html… 12 KB` and the size grows. The file text itself is never shown in the reply.
- When a reply finishes and it produced a file, the panel opens on that file if the panel is closed. (Builder's call: the last file in the reply.)
- **Cut-off file** (stopped/error reply): the card shows "Incomplete." It can still be opened and downloaded.
- **Compare mode:** cards work the same in every column. The panel shows whichever card was clicked.
- **Copy** on a message copies the text with each file block replaced by `[file: name.ext]`. Files are downloaded, not copied.
- **"Save as file"** appears on fenced code blocks of 20+ lines in assistant messages, next to Copy. It opens the code in the panel as a file named `snippet.<ext from the fence language>` (`.txt` if none), which can be downloaded from there. It is not saved back to the message.

## The side panel

- The panel opens to the right of the chat. The chat column narrows and stays readable and scrollable. The panel has a draggable divider (builder's call). Below about 900px wide, the panel covers the chat full-width with a close button.
- **Header:** file name, a version picker (`v1 · v2 · v3`) when the file has versions, **Download**, **Print / Save as PDF** (HTML only), and close.
- **Body by type:**
  - `.html` / `.htm`: runs live in a sandboxed iframe (below).
  - `.svg`: rendered as an image (`<img>` from a blob URL, so scripts inside don't run).
  - `.md`: rendered with the existing `Markdown` component.
  - `.csv`: a simple table. Builder's call: first 500 rows, with a note when there are more.
  - Anything else: highlighted text, using the existing highlighter.
- A **Code / Preview** toggle shows the raw source for rendered types.
- The panel belongs to the open chat. Switching chats closes it. It isn't remembered across reloads.

### Versions

- Files with the **same name** in assistant messages on the chat's **active path** are versions of one file, numbered in order. Other branches (regenerate, edit) don't count.
- The card for v2 says "v2." Opening it shows v2, and the picker can switch to other versions.
- **Compare mode** (*planner's call*): while a comparison is open, no column's reply is on the active path yet (`compare.ts` parks the leaf on the user message). Each column numbers its files as if its reply were next on the path, so a revision shows "v2" in every column. Its picker offers the path's versions plus that column's own. The panel does **not** auto-open when a comparison finishes; the user clicks the card they want.

### Sandbox (HTML)

The page must not be able to reach OpenChat's data or the API key.

- `<iframe sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox">`, **without** `allow-same-origin` (so it has a null origin: no cookies, no localStorage of OpenChat's, no reading the parent). Content goes in through `srcdoc`.
- Before rendering, OpenChat inserts a CSP `<meta>` at the top of `<head>`. It allows scripts (including `'unsafe-eval'`), styles, fonts and images inline and from `https:`, and images from `data:` and `blob:`. It sets `connect-src 'none'` and `form-action 'none'`, so the page can't fetch, post forms to, or open sockets to `localhost:3000` or anywhere else.
- **Links** open in a normal new tab (`<base target="_blank">`; the popup flags let it escape the sandbox, so source links load like any link). *Planner's call:* that's no more reach than a link in the chat's own Markdown, which already opens new tabs.
- *Planner's call:* `'unsafe-eval'` is allowed because many CDN libraries a model may use (Alpine.js, Vue's in-browser compiler and some charting libraries) need it. Safety comes from the null origin plus `connect-src 'none'`, not from blocking eval.
- **Print:** OpenChat also inserts a small script that calls `window.print()` when it receives a `print` message, and the panel's Print button posts that message. The printout is the page's own print layout (the user's own browser dialog; "Save as PDF" is a destination there).

### Images in a generated page

- When the HTML references a file name (`src="beach.jpg"`, also in CSS `url(...)`) that matches an **image attached anywhere in the chat**, OpenChat replaces it with that image as a `data:` URL, both in the panel and in the downloaded file. The download is then one self-contained `.html`.
- When two attachments share a name, the most recent wins.
- Images that don't match are left alone (CDN URLs work; unknown local names show as broken).

### Download

- Client-side, from a Blob with the right MIME type and the file name. Names are sanitised (no path separators). HTML downloads use the image-inlined version described above.

## Context and cost

Every file stays in the chat history that's sent with later messages, so a 30 KB page costs about 8–10k prompt tokens on every turn after it. To keep that down:

- When building the prompt, **older versions** of a file on the path are replaced with `<file name="x.html" superseded="true" />`. Only the latest version of each file is sent in full. This happens in `buildMessages` for assistant messages only.
- The existing Context popover already shows the token count, so the user can see what files are costing.

There are no new stats. Files come out of the same reply call, so cost and tokens are already logged.

## Testing

- Parser unit tests: plain text, one file, several files, a fenced block, an unclosed block, a tag not at line start (not a file), a user message (not parsed), and attributes with escaped quotes.
- Prompt tests: the file section is always present in replies and absent for titles and memory; superseded versions are collapsed and the latest is kept in full.
- Version numbering across the active path, including branches.
- Image inlining: matching name, no match, CSS `url()`, duplicate names.
- Component tests for the card states (writing, complete, incomplete, versioned) and the "Save as file" threshold.
- A manual check in the running app with a real model: the model-comparison prompt with web search on, a revision ("make the bars blue") producing v2, Print to PDF, and a brochure with an attached image.

## Left to the builder

The exact system-prompt wording, icons and styling, panel width and the divider, how the version picker looks, the CSV row cap, and the narrow-screen breakpoint. Also:

- making `/api/context` and the Context popover reflect the file section, the image names and the collapsed old versions;
- stripping file bodies from the transcript that title generation sees;
- which quote escapes the `name` attribute accepts;
- how search snippets look when the match is inside a file.
