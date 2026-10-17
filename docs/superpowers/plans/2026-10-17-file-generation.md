# File Generation in Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any chat model hand the user files. A reply can contain `<file name="…">` blocks, which OpenChat shows as file cards that open in a live side panel with Download and Print / Save as PDF.

**Architecture:**
- Files live inside assistant message `content`, exactly as the model wrote them, so there's no new table.
- A shared parser (`shared/files.ts`) splits content into text and file segments, and computes versions and the text transforms (copy, title, superseded).
- The server adds a file section to the reply system prompt and collapses old versions.
- The web client renders file segments as cards. It also has a side panel: HTML runs in a null-origin sandboxed iframe with an injected CSP.

**Tech Stack:** TypeScript, Hono + better-sqlite3 (server), React 19 + Vite (web), Vitest (node environment; there's no DOM test setup, so UI logic goes into pure functions that are tested, and components are checked by hand).

**Spec:** `docs/superpowers/specs/2026-10-17-file-generation-design.md`

## Global Constraints

- Format: an opening `<file name="name.ext">` and a closing `</file>`, each on its own line, with raw content between them and no code fence. Only **assistant** messages are parsed.
- No new table or migration. Files stay in `messages.content`.
- The file section is in the **reply** system prompt only. It's never in title or memory prompts. It's about 150 tokens.
- Older versions on the path are sent to the model as `<file name="x.html" superseded="true" />`, and only the latest is sent in full.
- Iframe: `sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"`, never `allow-same-origin`, with content through `srcdoc`.
- Injected CSP: scripts (with `'unsafe-eval'`), styles, fonts and images inline and from `https:`; images also from `data:` and `blob:`; `connect-src 'none'`; `form-action 'none'`. Plus `<base target="_blank">`.
- "Save as file" appears on fenced code blocks of **20+ lines** in assistant messages. It is named `snippet.<ext>` (`.txt` when there's no language).
- CSV preview caps at 500 rows, with a note when there are more.
- Narrow screens (< 900px wide): the panel covers the chat full-width.
- Commits use the `feat(web): …` / `feat(server): …` style and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never stop or reuse the user's OpenChat server on port 3000 or its `data/openchat.db`.** Manual checks use port 3100 and a copied DB.

## Review Focus

1. **The model writes `</file>` inside the file**, for example HTML that shows the tag as example text, or `</file>` not on its own line. Only a line that is exactly `</file>` (trimmed) closes the block. Pinned in Task 1 (`closes only on a line that is exactly </file>`).
2. **A file name with a path or odd characters** (`../../etc/passwd`, `a/b.html`, `"quoted".md`). Downloads must use a safe base name. Pinned in Task 1 (`safeFileName`).
3. **A reply stopped mid-file and then regenerated.** The cut-off file must not become "v1" of the new branch's file. Versions come from the active path only. Pinned in Task 2 (`ignores other branches`).
4. **HTML with no `<head>` or no `<html>`** (a model often writes a fragment). The CSP must still be the first thing in the head. Pinned in Task 4 (`adds a head when missing`).
5. **A user message containing `<file>` text**, such as pasted HTML or a text attachment the user typed out. It must stay plain text and must not count toward versions. Pinned in Task 2 (`skips user messages`).

---

### Task 1: Shared file-block parser

**Files:**
- Create: `shared/files.ts`
- Test: `shared/files.test.ts`

**Interfaces:**
- Produces:
  - `interface FileBlock { name: string; content: string; complete: boolean }`
  - `type Segment = { type: 'text'; text: string } | { type: 'file'; file: FileBlock }`
  - `parseFileBlocks(text: string): Segment[]`
  - `mapFileBlocks(text: string, fn: (file: FileBlock) => string): string`. It rewrites each block (including its tags) to `fn`'s result and leaves the other text untouched.
  - `type FileKind = 'html' | 'svg' | 'md' | 'csv' | 'code' | 'other'`
  - `fileKind(name: string): FileKind`. `html`/`htm` → html, `svg`, `md`/`markdown` → md, `csv`, and a known code extension list (ts, tsx, js, jsx, py, json, css, sh, sql, yaml, yml, xml, java, c, cpp, go, rs, rb, php, txt) → code, otherwise other.
  - `mimeFor(name: string): string` (text/html, image/svg+xml, text/markdown, text/csv, application/json, otherwise text/plain; all `;charset=utf-8` except svg).
  - `safeFileName(name: string): string`

- [ ] **Step 1: Write the failing tests** in `shared/files.test.ts`:

```ts
describe('parseFileBlocks', () => {
  it('returns one text segment for plain text', () =>
    expect(parseFileBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]));
  it('splits text, a file, and trailing text', () =>
    expect(parseFileBlocks('Here:\n<file name="a.html">\n<p>x</p>\n</file>\nDone')).toEqual([
      { type: 'text', text: 'Here:\n' },
      { type: 'file', file: { name: 'a.html', content: '<p>x</p>', complete: true } },
      { type: 'text', text: '\nDone' },
    ]));
  it('parses several files in order', () => { /* two blocks → names ['a.css','b.js'] */ });
  it('strips one code fence wrapped around a whole block', () => {
    // '```html\n<file name="a.html">\n<p/>\n</file>\n```' → one file, content '<p/>', no text segment containing ```
  });
  it('marks an unclosed block at the end as incomplete', () =>
    expect(parseFileBlocks('<file name="a.md">\n# T\nmore').at(-1)).toEqual(
      { type: 'file', file: { name: 'a.md', content: '# T\nmore', complete: false } }));
  it('ignores a tag that does not start a line', () =>
    expect(parseFileBlocks('use <file name="a.txt"> tags')).toHaveLength(1));
  it('closes only on a line that is exactly </file>', () => {
    // content line 'x </file> y' stays inside; the block closes at a later '</file>' line
  });
  it('decodes &quot; and &amp; in the name', () =>
    expect((parseFileBlocks('<file name="a &quot;b&quot;.txt">\nx\n</file>')[0] as any).file.name).toBe('a "b".txt'));
});
describe('mapFileBlocks', () => {
  it('replaces blocks and keeps text', () =>
    expect(mapFileBlocks('A\n<file name="x.txt">\n1\n</file>\nB', (f) => `[file: ${f.name}]`)).toBe('A\n[file: x.txt]\nB'));
});
describe('fileKind / mimeFor / safeFileName', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(fileKind('A.HTML')).toBe('html'); expect(fileKind('x.svg')).toBe('svg');
    expect(fileKind('n.md')).toBe('md'); expect(fileKind('d.csv')).toBe('csv');
    expect(fileKind('s.py')).toBe('code'); expect(fileKind('blob.bin')).toBe('other');
  });
  it('keeps only a safe base name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a/b.html')).toBe('b.html');
    expect(safeFileName('a\\b:c*?.txt')).toBe('b_c__.txt');
    expect(safeFileName('   ')).toBe('file.txt');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run shared/files.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `shared/files.ts`.** Scan line by line. An opening line matches `/^\s*<file\s+name="([^"]*)"\s*>\s*$/`, and the closing line is `line.trim() === '</file>'`. For the fence tolerance: if the line immediately before an opening tag is a fence (```` ```lang ````) and the line after its `</file>` is ```` ``` ````, drop both fence lines. Text segments keep their exact characters (including newlines), and empty text segments are dropped. `safeFileName` takes the last path segment after `/` or `\`, replaces `<>:"|?*` and control characters with `_`, trims, and falls back to `file.txt`.
- [ ] **Step 4: Run** `npx vitest run shared/files.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: shared parser for generated file blocks`.

### Task 2: Versions and text transforms

**Files:**
- Modify: `shared/files.ts`
- Test: `shared/files.test.ts`

**Interfaces:**
- Consumes: `parseFileBlocks`, `mapFileBlocks`, `FileBlock` (Task 1).
- Produces:
  - `interface FileVersion { name: string; messageId: string; version: number; file: FileBlock }` (version is 1-based)
  - `fileVersions(path: { id: string; role: 'user' | 'assistant'; content: string }[]): Map<string, FileVersion[]>`. Keyed by name, oldest first. Only assistant messages count, and the caller passes the active path (plus, in compare mode, one column's reply at the end).
  - `copyText(content: string): string`. Each block becomes `[file: name.ext]`.
  - `collapseSuperseded(path: { role: 'user' | 'assistant'; content: string }[]): string[]`. Returns each message's content, with every assistant file block that has a later same-name block on the path replaced by `<file name="NAME" superseded="true" />` (the name attribute-escaped).

- [ ] **Step 1: Write the failing tests:**

```ts
const a = (id: string, content: string) => ({ id, role: 'assistant' as const, content });
const u = (id: string, content: string) => ({ id, role: 'user' as const, content });
const f = (name: string, body: string) => `<file name="${name}">\n${body}\n</file>`;
describe('fileVersions', () => {
  it('numbers same-name files across the path', () => {
    const v = fileVersions([u('1', 'make'), a('2', f('p.html', 'v1')), u('3', 'blue'), a('4', f('p.html', 'v2'))]);
    expect(v.get('p.html')!.map((x) => [x.messageId, x.version, x.file.content])).toEqual([['2', 1, 'v1'], ['4', 2, 'v2']]);
  });
  it('skips user messages', () =>
    expect(fileVersions([u('1', f('p.html', 'x'))]).size).toBe(0));
  it('ignores other branches', () => {
    // a stopped sibling reply holding p.html is not on the path → only the path's p.html is v1
  });
});
it('copyText replaces blocks with markers', () => expect(copyText(`Hi\n${f('a.csv', '1,2')}`)).toBe('Hi\n[file: a.csv]'));
it('collapseSuperseded keeps only the latest version in full', () => {
  const out = collapseSuperseded([u('1', 'x'), a('2', f('p.html', 'old')), a('4', f('p.html', 'new') + '\n' + f('q.md', 'q'))]);
  expect(out[1]).toBe('<file name="p.html" superseded="true" />');
  expect(out[2]).toContain('new'); expect(out[2]).toContain('q.md');
});
```

- [ ] **Step 2: Run** `npx vitest run shared/files.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the three functions in `shared/files.ts`.
- [ ] **Step 4: Run** `npx vitest run shared/files.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: file versions and text transforms`.

### Task 3: Server — reply system prompt, superseded versions, title, context, chat images

**Files:**
- Modify: `server/src/prompt.ts`, `server/src/generate.ts:31-40`, `server/src/routes/context.ts:18-31`, `server/src/title.ts` (transcript), `server/src/chats.ts` (`getChatDetail`), `shared/types.ts` (`ChatDetail`)
- Test: `server/test/prompt.test.ts`, `server/test/generate.test.ts`, `server/test/context.test.ts`, `server/test/chats.test.ts`

**Interfaces:**
- Consumes: `collapseSuperseded`, `mapFileBlocks` (Tasks 1–2).
- Produces:
  - `FILE_INSTRUCTIONS_HEADER = 'Files:'` (the section's first line, so tests can find it).
  - `fileInstructions(imageNames: string[]): string`
  - `replySystemPrompt(p: Persona, imageNames: string[]): string`. It's `buildSystemPrompt(p)` (when not null) joined with `fileInstructions` by a blank line, and is never null.
  - `buildMessages(p, path, o?, files?: { imageNames: string[] })`. When `files` is given, the system message is `replySystemPrompt` and assistant contents go through `collapseSuperseded`. Without it, behaviour is unchanged (titles and memory don't pass it).
  - `chatImageNames(db: DB, chatId: string): string[]`, in `server/src/attachments.ts`. These are the distinct filenames of image attachments on any message in the chat, newest first.
  - `ChatDetail.chatImages: Attachment[]`, the image attachments on any message in the chat, newest first, deduplicated by filename (newest wins).

- [ ] **Step 1: Write the failing tests:**
  - `prompt.test.ts › fileInstructions` lists the given image names (`expect(fileInstructions(['beach.jpg'])).toContain('beach.jpg')`), and says to use `<file name=`, to rewrite the whole file under the same name, to make HTML self-contained, and to use print CSS. Assert each with `toContain` on a key phrase you choose.
  - `prompt.test.ts › replySystemPrompt` with an empty persona starts with `FILE_INSTRUCTIONS_HEADER`; with aboutMe `Sam`, it starts with `About the user:\nSam\n\n` and then contains the header.
  - `prompt.test.ts › buildMessages with files` collapses a superseded assistant block and leaves `buildMessages(empty, path)` (no `files`) unchanged, which is the existing test.
  - `generate.test.ts › file generation`: a send's captured OpenRouter request has a system message containing `FILE_INSTRUCTIONS_HEADER` and the chat's image name, using the existing fake client's captured `messages`.
  - `generate.test.ts › file generation`: the title transcript sent for a reply containing a file has `[file: a.html]` and not the file body.
  - `context.test.ts › GET /api/context` counts the file section in `parts.system` (it's > 0 with an empty persona).
  - `chats.test.ts`: `getChatDetail(...).chatImages` holds an image attached on a non-active branch, and the newest of two same-name images.
- [ ] **Step 2: Run** `npx vitest run server/test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `promptFor` passes `{ imageNames: chatImageNames(db, chatId) }`.
  - The context route uses `replySystemPrompt(persona, chatImageNames(db, chatId))` (with `[]` when there's no chat), and maps the path's assistant contents through `collapseSuperseded` before `estimateContext`.
  - In `title.ts`, the transcript is built from `mapFileBlocks(m.content, (f) => \`[file: ${f.name}]\`)` for assistant messages.
  - Write `fileInstructions` in plain words covering every bullet in the spec's "The format" section (about 150 tokens). When `imageNames` is empty, leave out the image sentence.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS, and `npm run typecheck` is clean.
- [ ] **Step 5: Commit** `feat(server): teach reply models to write files`.

### Task 4: Preview helpers (pure)

**Files:**
- Create: `web/src/lib/filePreview.ts`
- Test: `web/src/lib/filePreview.test.ts`

**Interfaces:**
- Produces:
  - `PANEL_CSP: string` (the exact policy from Global Constraints)
  - `inlineImages(html: string, images: Map<string, string>): string`. It replaces `src="NAME"`, `src='NAME'` and `url(NAME)` / `url("NAME")` / `url('NAME')` when NAME is a key (an exact filename match) with the data URL.
  - `prepareHtml(html: string, images: Map<string, string>): string`. It runs `inlineImages`, then inserts `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`, `<base target="_blank">` and `PRINT_LISTENER` as the **first** children of `<head>`.
  - `PRINT_LISTENER: string`. It's a `<script>` that calls `window.print()` on `message` events whose `data === 'openchat:print'`.
  - `csvRows(text: string, cap = 500): { rows: string[][]; more: number }`. It handles quoted fields with commas, doubled quotes and newlines.
  - `saveableCode(code: string): boolean`. This is `code.split('\n').length >= 20` (after trimming one trailing newline).
  - `snippetName(lang: string | undefined): string`. It maps fence languages to extensions (js, ts, py, html, css, json, sh, sql, md, csv, svg, yaml…), unknown or missing gives `snippet.txt`, and it uses `safeFileName`.

- [ ] **Step 1: Write the failing tests:**
  - `prepareHtml('<html><head><title>T</title></head><body></body></html>', new Map())` has the CSP meta before `<title>`.
  - `adds a head when missing`: `prepareHtml('<p>x</p>', new Map())` starts with `<head>` (after an optional doctype) and contains the CSP, then `<p>x</p>`. With `<html>` but no head, the head goes right after `<html…>`.
  - `PANEL_CSP` contains `connect-src 'none'`, `form-action 'none'` and `'unsafe-eval'`.
  - `inlineImages` replaces `src="beach.jpg"` and `url('beach.jpg')`, and leaves `src="https://x/beach.jpg"` and `src="other.png"` alone.
  - `csvRows('a,b\n"x,1","say ""hi"""', 500)` gives `[['a','b'],['x,1','say "hi"']]`, and with 600 rows and cap 500, `more === 100`.
  - `saveableCode` is false at 19 lines and true at 20. `snippetName('python') === 'snippet.py'` and `snippetName(undefined) === 'snippet.txt'`.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/filePreview.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with string operations only (it must run in node).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): preview helpers for generated files`.

### Task 5: File cards in replies

**Files:**
- Create: `web/src/components/FileCard.tsx`, `web/src/components/MessageBody.tsx`, `web/src/components/FilePanelContext.ts`
- Modify: `web/src/components/MessageItem.tsx` (assistant body and copy), `web/src/components/ChatView.tsx:340-343` (streaming slot), `web/src/components/CompareColumns.tsx:46`, `web/src/styles.css`

**Interfaces:**
- Consumes: `parseFileBlocks`, `copyText`, `fileKind`, `FileVersion` (Tasks 1–2).
- Produces:
  - `FilePanelContext = React.createContext<FilePanelApi | null>(null)`, where `interface FilePanelApi { open(name: string, messageId: string | null, file: FileBlock): void; versionOf(name: string, messageId: string | null): number | null; download(file: FileBlock): void }`. `download` inlines chat images into HTML (Task 6). A null context means cards render without opening (Task 6 provides it).
  - `<MessageBody text={string} messageId={string | null} streaming={boolean} />`. It renders `parseFileBlocks(text)`: text segments through `Markdown`, file segments through `FileCard`.
  - `<FileCard file={FileBlock} messageId={string | null} streaming={boolean} />`

- [ ] **Step 1: Implement `FileCard`.**
  - It shows the type icon (from `fileKind`), name, size (`formatBytes` from `web/src/lib/format.ts`, of the UTF-8 length), a `v{n}` label when `versionOf` ≥ 2, and a Download button. It calls `context.download(file)`; when there's no context, it falls back to a Blob with `mimeFor`, named with `safeFileName`.
  - States: `!complete && streaming` shows `Writing {name}… {size}`, and Download is hidden; `!complete && !streaming` shows "Incomplete"; complete shows normally.
  - Clicking anywhere but Download calls `open`.
- [ ] **Step 2: Implement `MessageBody`** and use it in `MessageItem` (assistant), the single streaming slot in `ChatView` (`messageId` null, `streaming` true), and `CompareColumns` (`messageId` = `col.message?.id ?? null`, `streaming` = `col.streaming`). Change assistant Copy in `MessageItem` to `copyText(message.content)`.
- [ ] **Step 3: Check it.** Run `npm run typecheck` and `npx vitest run`, and expect both clean. Then load the dev build (see Task 8's setup) with a chat whose assistant message content is pasted in through the DB copy. The card shows, the file text does not appear in the reply, and Copy gives `[file: …]`.
- [ ] **Step 4: Commit** `feat(web): file cards in replies`.

### Task 6: Side panel

**Files:**
- Create: `web/src/components/FilePanel.tsx`, `web/src/lib/useChatImages.ts`
- Modify: `web/src/components/ChatView.tsx` (layout, context provider, auto-open), `web/src/styles.css`

**Interfaces:**
- Consumes: `FilePanelContext` / `FilePanelApi` (Task 5); `fileVersions` (Task 2); `prepareHtml`, `inlineImages`, `csvRows` (Task 4); `ChatDetail.chatImages` (Task 3); `attachmentUrl` (`web/src/api.ts:73`).
- Produces:
  - `useChatImages(images: Attachment[]): Map<string, string>`. It fetches each image attachment once and returns filename → data URL, cached per attachment id.
  - `<FilePanel name versions={FileVersion[]} initialVersion={number} adhoc={FileBlock | null} images={Map<string,string>} onClose />`. `adhoc` is for "Save as file" snippets, which have no versions.

- [ ] **Step 1: ChatView state.**
  - `openFile: { name: string; messageId: string | null; adhoc: FileBlock | null } | null`, reset when `chatId` changes.
  - The version source is `fileVersions(messages)`, plus, for a compare column, that column's reply appended (computed when a column's card is opened).
  - Provide `FilePanelContext` with `open` and `versionOf`.
- [ ] **Step 2: Layout.** Wrap the messages and composer column, and the panel, in a flex row (`.chat-body`). The panel has a draggable divider (width kept in component state, min 320px). At `max-width: 900px`, the panel is `position: fixed; inset: 0` with a close button.
- [ ] **Step 3: `FilePanel`.**
  - Header: name, version picker (`v1 · v2 · …`; only when there are 2+ versions), Download, **Print / Save as PDF** (html only; it does `iframe.contentWindow.postMessage('openchat:print', '*')`), and close.
  - **Code / Preview** toggle for html, svg, md and csv.
  - Body by kind:
    - html: `<iframe sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox" srcDoc={prepareHtml(content, images)} />`
    - svg: `<img src={blobUrl}>` (revoke on change)
    - md: `Markdown`
    - csv: a table from `csvRows`, with "Showing 500 of N rows" when `more > 0`
    - otherwise: a `<pre><code>` highlighted with highlight.js (already a dependency)
  - Incomplete files show a muted "Incomplete. The reply stopped before this file finished." bar.
- [ ] **Step 4: Auto-open.** When a single (non-compare) reply's stream finishes (the `done` event) and its content has at least one complete file, and the panel is closed, open the **last** complete file in that reply. Compare streams never auto-open.
- [ ] **Step 5: Check it** in the dev build (Task 8 setup). Use a reply with an HTML file that loads Chart.js from cdnjs, an `<a href>` link and a `fetch('/api/settings')` call:
  - the chart renders
  - the link opens a normal tab
  - the console shows the fetch blocked by CSP
  - Print opens the dialog
  - an attached `beach.jpg` shows in the page and in the downloaded file
  - the panel goes full-width below 900px
- [ ] **Step 6: Commit** `feat(web): file side panel with live preview`.

### Task 7: "Save as file" on long code blocks

**Files:**
- Modify: `web/src/components/Markdown.tsx` (`CodeBlock`)

**Interfaces:**
- Consumes: `FilePanelContext` (Task 5); `saveableCode`, `snippetName` (Task 4).

- [ ] **Step 1: Implement.** When `FilePanelContext` is present and `saveableCode(text)` is true, `CodeBlock` shows a **Save as file** button next to Copy. Read the language from the inner `<code>` element's `language-xxx` class. The button calls `open(snippetName(lang), null, { name, content: text, complete: true })` as an ad-hoc panel file. The context is only provided inside `ChatView`, and user bubbles don't render Markdown, so this only appears on assistant output.
- [ ] **Step 2: Check it.** A 25-line Python block shows the button and opens `snippet.py` in the panel with Download. A 10-line block shows no button.
- [ ] **Step 3: Commit** `feat(web): save long code blocks as files`.

### Task 8: End-to-end check with a real model

**Files:**
- Modify: `vite.config.ts` (the proxy target follows `OPENCHAT_PORT`)

- [ ] **Step 1: Make the dev proxy configurable.** Set `proxy: { '/api': \`http://127.0.0.1:${process.env.OPENCHAT_PORT ?? 3000}\` }`. Commit `chore: dev proxy follows OPENCHAT_PORT`.
- [ ] **Step 2: Start a separate instance.** Copy `data/openchat.db` (and its `-wal`/`-shm`) to the scratchpad. Start the server with `OPENCHAT_PORT=3100 OPENCHAT_DB=<copy>` and vite with `--port 5174` and `OPENCHAT_PORT=3100`, through `.claude/launch.json` entries and `preview_start`. **Don't touch port 3000.**
- [ ] **Step 3: Run the spec's manual checks** with DeepSeek V4.1 Flash (cheap, tools on), with web search on:
  1. "Make an HTML page that graphically compares the top AI models right now." The card streams, the panel auto-opens, and the chart runs.
  2. "Make the bars blue." This gives v2, and the picker switches between v1 and v2.
  3. Print / Save as PDF shows a print preview.
  4. Attach an image and ask for a one-page brochure that uses it. The image shows in the panel and in the downloaded HTML.
  5. Compare mode with two models. The cards work in both columns and nothing auto-opens.
  6. Stop a reply mid-file. The card shows Incomplete.

  Note the cost of each step from the meta line.
- [ ] **Step 4: Report** the results with screenshots. Stop the 3100/5174 servers and remove the launch entries (the user dropped their local launch config in `0b17cae`).
