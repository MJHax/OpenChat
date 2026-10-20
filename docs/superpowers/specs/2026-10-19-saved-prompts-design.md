# Saved prompts: design

## Why

The user keeps retyping the same pieces of prompts: instructions about how to reply ("short bullet points, no preamble"), step-by-step procedures, and bits of syntax they need again and again. Saved prompts let them write each piece once and drop it in whenever they need it. They can start a new chat with it, or add it to the message they're writing in a chat that's already going.

Most of these pieces are word-for-word the same every time. Some have one part that changes, like a file name, so a prompt can contain a fill-in slot.

## Goals

- A **Saved prompts** window the user can open from anywhere, where they create, edit, delete and search prompts.
- From a prompt, the user can:
  - **Insert into message**: put it into the current chat's message box.
  - **Start new chat**: open a fresh chat with the prompt in the message box.
  - **Copy**: copy it to the clipboard.
- **Slots:** writing `{{name}}` in a prompt makes a fill-in field. The user fills each slot before the prompt is inserted, used for a new chat, or copied.
- Prompts are stored on the server like memories, so they are kept with the user's other data and included in data export, import and wipe.

## Non-goals

- **Saving a message as a prompt** from the chat transcript. Prompts are written in the window. The user saw this left out in the playback and didn't ask for it.
- Using a prompt as a chat's **instructions**. "Use it in an existing chat" means putting it in the message box. Chat instructions and global custom instructions stay as they are.
- Folders, tags, sharing, or prompts in the Images, Video or Discussions composers.
- Slot types, default values or dropdowns. A slot is plain text.

## Anti-goals

- **Inserting over what the user typed, or mixing into it.** Inserting must never replace or reorder the user's draft, and never run the prompt into the middle of their sentence (see "Insert into message" below).
- **Sending without the user's say-so.** Neither action sends a message. The prompt goes into the box, and the user sends it.
- **Losing the chat behind the window.** Opening the window must not reset the chat's draft, attachments or scroll position.

## Decided by the user

- **Placement:** its own icon on the icon rail (`web/src/components/shell/IconRail.tsx`), a bookmark.
- **Opens as a window over the page**, like Settings does (`web/src/App.tsx:38-45`, `web/src/pages/Settings`). The page behind stays mounted.
- **Window layout** (mockup `prompts-window.html`):
  - **Left:** the window title, a **＋ New** button, a search box, and the list of prompts, each shown as its title with the first line of its text under it.
  - **Right:** the selected prompt's title and text, with Edit, Delete and Close controls, then one field per slot, then the buttons **Copy**, **Start new chat** and **Insert into message**. Insert into message is the primary button.
- **Insert into message:** closes the window and adds the prompt to the chat's message box at the cursor, **on its own line**. If there is text before the cursor on the same line, a line break goes in before the prompt. If there is text after the cursor on the same line, a line break goes in after it. Nothing the user typed is replaced. If the box is empty, the prompt is the whole text.
- **Start new chat:** closes the window, opens a new chat (`#/`), and puts the prompt in its message box. It is not sent.
- **Slots:** `{{file}}` style. A prompt with no slots is used as soon as its button is clicked. A prompt with slots shows its fields in the detail pane, and the buttons use the filled-in text.
- **Composer button:** a small bookmark button in the chat composer bar opens the same window (my suggestion in playback, which the user accepted).

## Builder's calls (made during brainstorming, not confirmed by the user)

- **Storage:** a new `saved_prompts` table (`id`, `title`, `content`, `created_at`, `updated_at`) and CRUD routes at `/api/prompts`, modeled on `server/src/routes/memories.ts`. It is added to `exportData.ts` and to `ALL_TABLES` in `dataStore.ts` so export, import and wipe cover it.
- **Rail position:** after Library, in the Model Library, Stats and Library group, because it's a tool rather than a thread mode.
- **When there's no chat message box behind the window** (Images, Video, Discussions, Model Library, Stats, Library), Insert into message is disabled and its tooltip says why. Start new chat and Copy still work. The new-chat home (`#/`) has a message box, so Insert works there. A chat that is streaming also allows Insert, because its textarea stays editable while a reply streams.
- **Insert target and cursor:** Insert targets only the chat's main composer, not an open edit-message box. The composer remembers its last selection when it loses focus, and Insert uses that. If the box was never focused, the prompt is added at the end. After inserting, the box is focused with the cursor right after the inserted text.
- **Slot syntax:** `{{name}}`, where the name is letters, digits, `_`, `-` and spaces, trimmed. The same name used twice is one field and fills both places. A slot left empty stays as the literal `{{name}}`, so the user can see it and fix it in the box.
- **Title:** optional. If it's empty, the list shows the start of the text instead.
- **List order:** most recently updated first. Search matches the title and the text, ignoring case.
- **New prompt:** opens an empty editor in the right pane. Save and Cancel buttons. Saving an empty text is refused.
- **Delete** asks for confirmation, like deleting a chat does.
- **Keyboard:** Esc closes the window. It also appears as an entry in the command palette (`CommandPalette.tsx`), as Settings tabs do.

## Left to the builder

- Whether the window is a hash route like `#/settings` (`settingsBackdrop` and `settingsCloseAction` in `web/src/lib/route.ts`) or plain App state. It must meet the "chat behind stays mounted" anti-goal either way.
- How Insert reaches the Composer. The Composer's existing `prefill` replaces the text, and its cursor position is internal. Insert needs a new path that reads the textarea's selection and adds the text there. Start new chat can probably reuse `prefill`, or the `startDraft` handoff the Library uses.
- The exact look, built on the existing `.popover`, `.pop-item` and Settings dialog styles, in both themes.
- Tests in the existing style: server route tests next to `server/test/` (for example `settingsRoutes.test.ts`), and pure helpers (slot parsing and filling, the new-line insert logic) as `web/src/lib/*.ts` with `*.test.ts`.
