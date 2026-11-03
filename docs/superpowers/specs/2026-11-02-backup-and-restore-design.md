# Backup and restore: design

## Why

The user runs OpenChat on their laptop and now also in Docker on a home server. They want to move their whole setup from one instance to another (laptop to server, first of all) without copying database files around by hand, and to keep a copy they can bring back if they delete an instance later.

Today's export can't do this. It was made for reading: Markdown files per chat plus a `data.json` with most rows. It leaves out tables such as usage stats and the model list, and there is no way to load it back in.

## Goals

- **Export makes a full backup.** The zip from **Export all data** (Settings › Data) also holds a complete copy of the instance's data: the database and the video clips. Everything the user would lose by deleting the instance is in it, except the API keys (below).
- **Import restores a backup.** A new **Import** section below Export in Settings › Data. The user picks an export zip, confirms, and everything in this instance is replaced by what's in the zip. The page then reloads into the restored data.
- **Older backups load into newer versions.** A backup made by an older OpenChat restores into a newer one and is brought up to date, the same way `openDb`'s `migrate` brings an old database file up to date today.

## Non-goals

- **Merging.** Import replaces; it never combines a backup with what the instance already has. The user asked for "overwrite all existing files".
- **Importing anything but an OpenChat export.** No imports from other chat apps, and no restoring from the readable Markdown files or `data.json`.
- **Automatic or scheduled backups.** Export stays a button the user clicks.
- **Encrypting the zip.**

## Anti-goals

- **API keys in the backup.** The user decided the OpenRouter key (`api_key`) and Tavily key (`tavily_api_key`) must never be written into the zip, in any form, including the database copy. Today's `data.json` already leaves them out; the full copy must too.
- **Losing this instance's keys on import.** The backup has no keys, so import keeps the keys the instance already has. Restoring must not leave the user without their OpenRouter key.
- **A half-restored instance.** If anything goes wrong (a bad zip, a backup from a newer version, a failure midway), the instance is left exactly as it was before the import. Never part old data and part new.
- **Replacing data by accident.** Import destroys everything currently in the instance, so it needs a deliberate confirmation, and the dialog says so plainly.
- **Breaking the readable export.** The Markdown files, `data.json` and attachment files stay in the zip as they are today.

## Decided by the user

- One zip from one button does both jobs: readable files and a full backup.
- Import takes that zip and overwrites everything in the instance: chats, images, videos, discussions, settings, memories, saved prompts, models, stats.
- API keys are left out of the backup.
- The backup is a self-contained copy of the database and clips, separate from the readable files. Attachments, generated images and clips are therefore stored twice in the zip, roughly doubling its size; the user chose this for simplicity, "for now". A later version may share files between the two.

## Constraints

- **No restart.** Import happens while the server runs; the user may have no shell access to restart it (Docker). The server keeps one open database connection (`deps.db`, `server/src/index.ts`) that the rest of the app holds on to.
- **Size.** Attachments and generated images are stored inside the database, and clips are files in `data/videos`. A backup can be hundreds of megabytes. Export already streams (`server/src/zip.ts`), and import must not hold the whole upload in memory. The 20 MB limit on attachment uploads doesn't apply here.
- **Work in progress here.** Anything still writing to the database when the rows are replaced would mix old and new data. Import refuses, with a message saying what is still running, while any of these are under way: a streaming chat or compare reply (`inFlight` in `server/src/routes/generate.ts`), a discussion turn (`inFlight` in `server/src/routes/discussions.ts`), an image generation (`running` in `server/src/imageGen.ts`), or a clip job that isn't finished, including one whose thread was deleted (it is paid for and still polled). Those sets are private to their modules today, so each needs a way to be asked.
- **Work in progress inside the backup.** A backup can hold unfinished clip jobs, image generations and replies still marked as streaming. After restoring, they are marked as interrupted or failed, as `failInterruptedGenerations` does at startup. Restored clip jobs are never resumed: the instance that made the backup may still be polling the same job, and resuming would download it twice and record its cost twice.
- **A consistent copy.** The database runs in WAL mode while the app is in use, so copying `openchat.db` from disk can miss recent changes. The backup copy must be complete and consistent at the moment of export.
- **Security.** The import endpoint is subject to the same host check as the rest of `/api/*` (`server/src/app.ts`). Treat the uploaded zip as untrusted: entry names must not let files be written outside the data folder.

## Behaviour

**Export.** Same button and file name as today (`openchat-export-YYYY-MM-DD.zip`). The zip additionally holds the backup: the database copy with the two API key rows removed, and the clip files, plus a small file identifying it as an OpenChat backup and which OpenChat version made it.

**Import section.** Below Export: a short line saying it replaces everything in this OpenChat with a backup made by Export, and that API keys aren't included, so this instance keeps its own. Then a button to choose a file.

**Confirm dialog.** Like the existing delete dialogs (`web/src/pages/settings/DataTab.tsx`): a title, a plain warning that everything currently here will be replaced and that this can't be undone, the suggestion to export first, a typed confirmation word, and a primary danger button. While it runs, the button shows progress text and the dialog can't be dismissed.

**Errors** are shown in the dialog in plain words, and nothing changes:
- not an OpenChat export (including exports made before this feature, which have no backup in them);
- made by a newer version of OpenChat than this one ("Update this OpenChat first");
- a clip is still rendering;
- the file is damaged or the upload stopped.

**After success** the app reloads so every page shows the restored data. Detected local servers are looked for again, as at startup, since the backup may come from a machine where Ollama was at a different address.

## Left to the builder

- How the restore replaces the data without a restart: for example, opening the uploaded database separately, bringing it up to date with the existing migrations, and copying its rows into the live database in one transaction, as `deleteData(..., 'all')` empties tables today. The search index (`messages_fts`, kept by triggers) must be right afterwards.
- How "made by a newer version" is detected. `package.json` has said `0.1.0` from the start and the database has no `user_version`, so this needs a schema marker of some kind rather than the app version.
- How the backup is laid out inside the zip, and how the upload is received (streamed to a temporary file).
- The confirmation word.
- How clip files are swapped so a failure leaves the old ones in place.

## My calls (not discussed with the user)

- Restored settings include everything except the two keys, including local server addresses and spending limits. An address that's wrong on the new machine can be fixed in Settings.
- Import refuses rather than waits or cancels while anything is running, so no paid work is thrown away.
- Unfinished work in a restored backup is marked interrupted, never resumed.
- The app reloads after import rather than updating each page in place. Other open tabs and devices are not told; they keep showing old data until reloaded, and the confirm dialog says to reload them. OpenChat is for one person, so a push channel isn't worth it.
