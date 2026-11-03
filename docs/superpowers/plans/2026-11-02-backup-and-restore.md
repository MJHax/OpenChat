# Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export also writes a full backup (database copy without API keys, plus clips) into its zip, and a new Import in Settings › Data replaces everything in the instance with such a backup, without a restart.

**Architecture:** Export adds a `backup/` folder to the existing zip: a `VACUUM INTO` copy of the database with the key rows wiped, the clip files, and a manifest. Import streams the upload to a temporary file, reads the zip from disk, checks and migrates the backup database separately, stages the clips next to the media folder, then copies every table into the live database in one transaction and swaps the clip folder. Anything that fails before the transaction commits leaves the instance untouched.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-backup-and-restore-design.md`

## Global Constraints

- The settings rows `api_key` and `tavily_api_key` are never written into the zip in any form, including freed pages of the database copy.
- Import keeps this instance's own `api_key` and `tavily_api_key`.
- Any failure before the restore commits leaves the database and clip folder exactly as they were.
- Import refuses while a reply streams, a discussion turn runs, an image generates, or any `video_jobs` row has `finished_at IS NULL` (deleted threads included).
- Unfinished work in a restored backup is marked interrupted and never resumed.
- The readable export (Markdown, `data.json`, `attachments/`, `clips/`) stays byte-for-byte as today; existing `server/test/export.test.ts` must pass unchanged.
- Upload and zip reading are streamed; nothing holds a whole backup in memory. No body size limit on the import route.
- Confirmation word: `REPLACE`.
- Zip layout of the backup, inside the existing `openchat-export/` root:
  - `openchat-export/backup/manifest.json`: `{ "format": "openchat-backup", "formatVersion": 1, "schemaVersion": <SCHEMA_VERSION>, "createdAt": <ISO string> }`
  - `openchat-export/backup/openchat.db`
  - `openchat-export/backup/clips/<message id>.mp4`

## Review Focus

- **A key saved in Settings when exporting:** the key's text appears nowhere in the zip's bytes. Test in Task 3.
- **A zip entry named to escape the data folder** (`openchat-export/backup/clips/../../x.mp4`): it's refused and nothing is written outside the media folder. Test in Task 5.
- **An upload cut off midway (truncated zip):** it's refused as damaged, and nothing changes. Tests in Tasks 2 and 5.
- **Importing the same backup twice:** the second import gives the same result as the first, with no duplicated rows or search hits. Test in Task 5.
- **A backup made by an older schema (`user_version` 0):** it's migrated and imported. A newer one is refused with "Update this OpenChat first". Tests in Task 5.

---

### Task 1: Schema version stamp

**Files:**
- Modify: `server/src/db.ts` (`migrate`, new export)
- Test: `server/test/db.test.ts`

**Interfaces:**
- Produces: `export const SCHEMA_VERSION = 1` in `server/src/db.ts`. `openDb` leaves `PRAGMA user_version` equal to `SCHEMA_VERSION`.

- [ ] **Step 1: Write the failing test** `it('stamps the schema version')`: `openDb(':memory:')`, then `expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)`.
- [ ] **Step 2: Run it.** Run `npx vitest run server/test/db.test.ts`. Expected: FAIL (no export / 0).
- [ ] **Step 3: Implement.** Add `SCHEMA_VERSION` and set `user_version` at the end of `migrate`. Add a comment on the constant: bump it whenever `SCHEMA` or `migrate` changes, because import refuses backups with a higher number.
- [ ] **Step 4: Run it.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(db): stamp the schema version`.

### Task 2: Reading a zip from disk

**Files:**
- Create: `server/src/unzip.ts`
- Test: `server/test/unzip.test.ts`

**Interfaces:**
- Produces:
  - `export interface ZipFileEntry { name: string; dataOffset: number; size: number; crc: number }`
  - `export async function readZipIndex(file: string): Promise<Map<string, ZipFileEntry>>` reads the end record (and ZIP64 records), then the central directory and each local header's length, using `fs/promises` file handle reads only.
  - `export async function extractEntry(file: string, entry: ZipFileEntry, dest: string): Promise<void>` streams the bytes to `dest` with `createReadStream(file, { start, end })` and checks the CRC (`zlib.crc32`).
  - `export class ZipError extends Error {}`, thrown for anything malformed: missing end record, bad signatures, an offset or size past the file's end, or a CRC mismatch. On a CRC mismatch `extractEntry` removes `dest`.
- Store-only entries only (method 0). Any other method is a `ZipError`.

- [ ] **Step 1: Write the failing tests:**
  - `round-trips entries written by zipStream`: write `zipStream` output to a temp file, then index and extract two entries. The bytes equal the input.
  - `follows ZIP64 records`: the same with `zipStream(entries, { max32: 100 })` and a 300-byte entry.
  - `rejects a truncated file`: drop the last 10 bytes, then `readZipIndex` rejects with `ZipError`.
  - `rejects a bad CRC`: flip one data byte, then `extractEntry` rejects with `ZipError` and `dest` doesn't exist.
- [ ] **Step 2: Run them.** Run `npx vitest run server/test/unzip.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/src/unzip.ts`. `server/test/zipReader.ts` shows the record layout; this version reads from a file handle instead of a Buffer.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: read store-only zips from disk`.

### Task 3: Backup entries in the export

**Files:**
- Create: `server/src/backup.ts`
- Modify: `server/src/exportData.ts` (use `SECRET_SETTINGS` in the `data.json` settings query; yield `backupEntries(deps)` after the clips)
- Test: `server/test/backup.test.ts`

**Interfaces:**
- Consumes: `SCHEMA_VERSION` (Task 1).
- Produces, in `server/src/backup.ts`:
  - `export const SECRET_SETTINGS = ['api_key', 'tavily_api_key'] as const`
  - `export const BACKUP_DIR = 'openchat-export/backup'`
  - `export interface BackupManifest { format: 'openchat-backup'; formatVersion: 1; schemaVersion: number; createdAt: string }`
  - `export async function* backupEntries(deps: Deps): AsyncGenerator<ZipEntry>` yields the manifest, `openchat.db` and one entry per `*.mp4` in `deps.mediaDir`.
- The database copy: `VACUUM INTO` a temp file (this works for `:memory:` databases too). Open the copy with plain `new Database(...)`, set `PRAGMA secure_delete = ON`, delete the `SECRET_SETTINGS` rows, run `VACUUM`, and close it. Make the copy when the entry's `data()` is called, and remove the temp file in a `finally` after it has been streamed.

- [ ] **Step 1: Write the failing tests** (seed like `server/test/export.test.ts`, with `setSetting(db, 'api_key', 'sk-or-stored-1234567890')`, `setSetting(db, 'tavily_api_key', 'tvly-secret-987')`, and a clip file in `deps.mediaDir`):
  - `adds a backup with manifest, database and clips`: the `readZip` of `GET /api/data/export` has `openchat-export/backup/manifest.json` with `format: 'openchat-backup'`, `formatVersion: 1` and `schemaVersion: SCHEMA_VERSION`, plus `backup/openchat.db` and `backup/clips/<id>.mp4` with the clip's bytes.
  - `the database copy holds the data`: written to a temp file and opened, it has the seeded chats and memories, and no `api_key` or `tavily_api_key` rows.
  - `no key text anywhere in the zip`: the raw zip Buffer `includes` neither `sk-or-stored-1234567890` nor `tvly-secret-987`.
  - `leaves no temp files behind`: the temp folder you use holds no `openchat-backup-*` files after the download.
- [ ] **Step 2: Run them.** Run `npx vitest run server/test/backup.test.ts server/test/export.test.ts`. Expected: the backup tests FAIL and the export tests PASS.
- [ ] **Step 3: Implement** `server/src/backup.ts` and the two `exportData.ts` changes.
- [ ] **Step 4: Run them.** Expected: all PASS.
- [ ] **Step 5: Update the Export card text** in `web/src/pages/settings/DataTab.tsx`: "One .zip with each chat, image and video thread as a Markdown file, a JSON file with your data, every attachment, image and video, and a full backup that Import can restore. Your API keys are never included."
- [ ] **Step 6: Commit** with `feat: export includes a full backup without API keys`.

### Task 4: Knowing what is still running

**Files:**
- Create: `server/src/activity.ts`
- Modify: `server/src/routes/generate.ts:74`, `server/src/routes/discussions.ts:32` (use the shared sets), `server/src/imageGen.ts` (export a count)
- Test: `server/test/activity.test.ts`

**Interfaces:**
- Produces:
  - `export function workSets(db: DB): { replies: Set<string>; turns: Set<string> }`, kept in a `WeakMap<DB, …>`. `generationRoutes` and `discussionRoutes` use these sets in place of their local `inFlight`, with no other change in behaviour.
  - `export function imageGenerationsRunning(): number` in `server/src/imageGen.ts` (`running.size`).
  - `export function busyReason(deps: Deps): string | null` in `activity.ts`. It checks in this order and returns the first message that applies:
    - `'A reply is still being written. Wait for it to finish, then import.'`
    - `'A discussion turn is still running. Wait for it to finish, then import.'`
    - `'An image is still being generated. Wait for it to finish, then import.'`
    - `'A clip is still rendering. It is already paid for, so wait for it to finish, then import.'` when any `video_jobs` row has `finished_at IS NULL`, whether or not its thread exists.

- [ ] **Step 1: Write the failing tests:** `null` when idle; each message when its condition is set up. Add an id to `workSets(db).replies` and to `.turns`. Insert an unfinished `video_jobs` row whose `thread_id` matches no chat. For images, start a generation with a scripted `generateImage` that waits on a promise you resolve after the assertion, then `await whenIdle()`.
- [ ] **Step 2: Run them.** Run `npx vitest run server/test/activity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it and switch the two routes to `workSets`.
- [ ] **Step 4: Run** `npx vitest run server/test/activity.test.ts server/test/generate.test.ts server/test/discussionTurn.test.ts server/test/discussionData.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat: one place to ask what is still running`.

### Task 5: Restoring a backup

**Files:**
- Create: `server/src/restore.ts`
- Test: `server/test/restore.test.ts`

**Interfaces:**
- Consumes: `readZipIndex`, `extractEntry`, `ZipError` (Task 2); `BACKUP_DIR`, `BackupManifest`, `SECRET_SETTINGS` (Task 3); `busyReason` (Task 4); `SCHEMA_VERSION`, `openDb` (Task 1); `failInterruptedGenerations` (`server/src/imageGen.ts`); `purgeDeleted` (`server/src/dataStore.ts`).
- Produces: `export async function restoreBackup(deps: Deps, zipFile: string): Promise<void>`. It throws `HttpError` with these messages and changes nothing:
  - 409 with `busyReason`'s message.
  - 400 `"This isn't an OpenChat backup. Use a .zip made by Export in OpenChat."` for no manifest, a wrong `format`, or `formatVersion` ≠ 1. This covers exports made before this feature.
  - 400 `'This backup was made by a newer version of OpenChat. Update this OpenChat first.'` when the manifest's `schemaVersion` or the copy's `user_version` is above `SCHEMA_VERSION`.
  - 400 `'The backup file is damaged or incomplete. Export it again and retry.'` for any `ZipError`, a database copy SQLite can't open, or a clip entry whose file name isn't `^[0-9a-f-]{36}\.mp4$` once the `backup/clips/` prefix is removed.
- Order of work (each step only runs when the ones before it succeed):
  1. `busyReason`.
  2. Index the zip, then read and check the manifest.
  3. Extract `openchat.db` to a temp dir and read its `user_version` with a plain connection. Then `openDb` it, which migrates it. On the copy, run `failInterruptedGenerations`. Mark every unfinished `video_jobs` row finished, with its message `status = 'error'` and its `media_generations.error` set to `'Interrupted by a restore. The clip may still finish on the OpenChat this backup came from.'`. Record no `media_events`. Delete the `SECRET_SETTINGS` rows, then close the copy.
  4. Extract the clips into `${deps.mediaDir}.restoring` (same disk, so the swap is a rename).
  5. Read this instance's `SECRET_SETTINGS` rows. `ATTACH` the copy as `backup`. In one `db.transaction`, with `PRAGMA defer_foreign_keys = ON`: for every table in `main` from `sqlite_master` (type `table`, name not `sqlite_%` except `sqlite_sequence`, and not `messages_fts` or `messages_fts_%`), run `DELETE FROM` it, then `INSERT … SELECT` the columns both schemas share. Afterwards, put the saved key rows back and run `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`. `DETACH` in a `finally`.
  6. Swap folders: rename `mediaDir` to `${mediaDir}.old`, rename `.restoring` to `mediaDir`, then remove `.old`. Then run `purgeDeleted(db)`.
  7. In a `finally`: remove the temp dir and any leftover `.restoring`.

- [ ] **Step 1: Write the failing tests.** The helper `exportOf(seededApp)` writes `GET /api/data/export` to a temp file. The target is a second `makeApp()` with its own chat, clip, `api_key` `sk-or-target-1111111111` and `tavily_api_key` `tvly-target`.
  - `replaces everything with the backup`: the target's chats, memories, `about_me` and clip files equal the source's. The target's own chat and clip are gone.
  - `keeps this instance's keys`: both target keys are still set.
  - `search finds restored messages and not old ones`: use `GET /api/search` (see `server/test/` for the query shape).
  - `importing twice gives the same result`: the row counts of `messages` and the search hits for one word are equal after the first and second import.
  - `marks unfinished work in the backup as interrupted`: seed the source with an unfinished video job and an unfinished image generation. After the import, both messages have `status = 'error'`, `video_jobs` has no `finished_at IS NULL` row, and `media_events` gained no row.
  - `refuses an export with no backup inside`: a zip from `zipStream` with only `openchat-export/data.json` gives 400 with the not-a-backup message.
  - `refuses a newer backup`: rewrite the manifest with `schemaVersion: SCHEMA_VERSION + 1` (build the zip with `zipStream` from `readZip` entries). It gives 400 "Update this OpenChat first".
  - `imports an older backup`: set the copy's `user_version` to 0 and rebuild the zip. It succeeds.
  - `refuses a truncated zip`, `refuses a clip name that leaves the folder` (`openchat-export/backup/clips/../../x.mp4`), and `refuses while a clip renders`.
  - Each refusal test asserts that nothing changed: target chat ids, the key rows and the media folder listing are the same as before, no `${mediaDir}.restoring` exists, and no `x.mp4` exists outside `mediaDir`.
- [ ] **Step 2: Run them.** Run `npx vitest run server/test/restore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/src/restore.ts`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: restore a backup into the running instance`.

### Task 6: Import route

**Files:**
- Modify: `server/src/routes/data.ts`
- Test: `server/test/dataRoutes.test.ts`

**Interfaces:**
- Consumes: `restoreBackup` (Task 5); `detectLocalServers` (`server/src/localDetect.ts`).
- Produces: `POST /api/data/import?confirm=REPLACE`, whose body is the raw zip (`Content-Type: application/zip`). It returns `{ ok: true }`. Without `confirm=REPLACE` it returns 400 `'Type REPLACE to confirm.'` before reading the body. It streams the body to a temp file with `pipeline(Readable.fromWeb(c.req.raw.body), createWriteStream(...))`, then calls `restoreBackup`, removes the temp file in a `finally`, and on success starts `void detectLocalServers(deps.db, { candidates: deps.localCandidates }).catch(() => {})`.

- [ ] **Step 1: Write the failing tests:**
  - `import needs REPLACE`: 400 without it.
  - `import restores an export`: export from one app, then `app.request('/api/data/import?confirm=REPLACE', { method: 'POST', body: zipBuffer, headers: { 'Content-Type': 'application/zip' } })` into another gives 200, and the chats match.
  - `a cross-site import is refused`: the same request with `sec-fetch-site: cross-site` gives 403.
- [ ] **Step 2: Run them.** Run `npx vitest run server/test/dataRoutes.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the route.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** with `feat: import route`.

### Task 7: Import in Settings › Data

**Files:**
- Modify: `web/src/api.ts` (add `importData`), `web/src/pages/settings/DataTab.tsx`, `README.md` (a short "Moving to another machine" note under "Run it on a home server")

**Interfaces:**
- Consumes: `POST /api/data/import` (Task 6).
- Produces: `api.importData(file: File, confirm: string): Promise<{ ok: true }>`. It sends `fetch` with `body: file` and `Content-Type: application/zip`, and throws `ApiError` the way `json` does.

- [ ] **Step 1: Add the Import section** below the Export card, using the existing card and row classes:
  - The text reads "Replace everything in this OpenChat with a backup made by Export. Your API keys aren't in backups, so this OpenChat keeps its own."
  - Add a hidden `<input type="file" accept=".zip,application/zip">` and a button labelled "Import a backup…". Choosing a file opens `ConfirmImport`.
- [ ] **Step 2: Add `ConfirmImport`**, modelled on `ConfirmDelete`:
  - Title: "Replace everything with this backup?"
  - Body: the file's name and size (`formatBytes`), then "Every chat, image, video, discussion, memory, saved prompt, setting and stat here is replaced by the backup's. This can't be undone. Export first if you might want any of it." Then "Other open tabs and devices will show old data until you reload them."
  - A "Type REPLACE to confirm" field, and a danger button "Replace everything" that reads "Importing…" while it runs. The backdrop can't close the dialog while it's busy.
  - Errors appear in the dialog. On success, call `forgetAllPrefs()` and `window.location.reload()`.
- [ ] **Step 3: Run** `npm run typecheck` and `npm test`. Expected: PASS.
- [ ] **Step 4: Check it in the browser.** Use a separate instance (`OPENCHAT_PORT` other than 3000, `OPENCHAT_DB` in the scratchpad):
  - Export from one copy and import into a second.
  - Confirm the restored chats appear after the reload and the key status in Settings › General is unchanged.
  - Try a non-backup zip and a wrong confirm word; both show the error in the dialog.
  - Check the layout at phone width.
- [ ] **Step 5: Commit** with `feat(web): import a backup from Settings › Data`.
