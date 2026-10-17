# Images Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Images mode with image threads for generating and editing pictures through OpenRouter's image API. It includes an image-model list in the Model Library, an Images view in Stats, and a "From my chats" attach picker in the chat composer.

**Architecture:**
- Image threads are `chats` rows with `kind = 'image'`, and their messages reuse `messages`. A generated picture is an `attachments` row on the assistant message.
- Each assistant message's request lives in a new `media_generations` row, and each paid call is logged in a new `media_events` table. `usage_events` keeps its CHECK constraints and gains a `thread_kind` column, so title calls for image threads count under Images.
- Image models live in their own `media_models` table (keyed by id + kind), so they never mix with chat models. Project 3 reuses every one of these tables with `kind = 'video'`.

**Tech Stack:** TypeScript, Hono + better-sqlite3, React 19 + Vite, Vitest (node only; UI logic goes into pure, tested functions and components are checked by hand).

**Spec:** `docs/superpowers/specs/2026-10-17-images-tab-design.md`

**Prerequisite:** the file-generation plan (`2026-10-17-file-generation.md`) is done. The "From my chats" files section uses `shared/files.ts`.

## Global Constraints

- OpenRouter: `POST /api/v1/images` (`model`, `prompt`, `aspect_ratio`, `resolution`, `quality`, `background`, `input_references` as data URLs, `n: 1`). The response is `data[].b64_json` plus `usage`. The model list is `GET /api/v1/images/models` and pricing is `GET /api/v1/images/models/{id}/endpoints`.
- Always one image per generation (`n: 1`).
- Defaults:
  - aspect `1:1`, or `auto` when the model offers it and lacks `1:1`
  - size `1K`, or the model's smallest
  - quality `medium`, or the closest value
  - transparent background off
  - the model is whichever was used last
- Hidden models: SVG-only output models, and models with no providers. Models with no pricing show "Price unknown". Models with `input_references.min >= 1` show "Needs a photo".
- Estimates are always prefixed with `~`. Flat per-image and per-megapixel prices are exact, and per-token prices are estimates.
- One generation per thread at a time. There is no Stop. A generation finishes and is saved even if the client leaves. On startup, `generating` messages become `error` ("Interrupted").
- Failed calls are logged with cost 0, and the message says "Not charged".
- Generated images have no size cap. When one is copied into a chat attachment, or a photo is uploaded in the Images tab, the browser shrinks it to under 5 MB (JPEG, scaled down).
- Commits use the `feat(server): …` / `feat(web): …` style and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never touch port 3000 or `data/openchat.db`. Manual checks use port 3100 and a DB copy, as in the file-generation plan's Task 8.

## Review Focus

1. **A thread is deleted while its image is still generating.** The completion must not throw or recreate rows. The paid call is still logged in `media_events` with a null message. Pinned in Task 5 (`thread deleted mid-generation`).
2. **The user switches models after choosing an aspect, size or quality the new model lacks.** The value snaps to a supported one instead of sending a value that gets a 400. Pinned in Task 2 (`snapSettings`).
3. **A model rejects the prompt** (moderation, a 400 or a 502). The thread shows OpenRouter's message plus "Not charged" and unlocks the composer. Pinned in Task 5 (`failure unlocks and logs zero cost`).
4. **"Edit this" points at an image on another branch after Again plus sibling navigation.** The target must be resolved by attachment id, not by position. Pinned in Task 5 (`edits the chosen attachment`).
5. **An old database with existing chats and usage rows.** The migration gives every existing chat `kind = 'chat'` and every usage row `thread_kind = 'chat'`, so the Chats stats are unchanged. Pinned in Task 1 (`migrates existing rows`).

---

### Task 1: Schema

**Files:**
- Modify: `server/src/db.ts` (SCHEMA and `migrate`), `shared/types.ts` (`MessageStatus` adds `'generating' | 'error'`; `ChatSummary` adds `kind: ThreadKind`; `export type ThreadKind = 'chat' | 'image' | 'video'`)
- Test: `server/test/db.test.ts`

**Interfaces:**
- Produces these tables, used by every later task:
  - `chats.kind TEXT NOT NULL DEFAULT 'chat'`
  - `usage_events.thread_kind TEXT NOT NULL DEFAULT 'chat'`
  - `media_models(id TEXT, kind TEXT CHECK (kind IN ('image','video')), display_name TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (id, kind))`
  - `media_catalog_cache(kind TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL)`
  - `media_generations(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, kind TEXT NOT NULL, model_id TEXT NOT NULL, prompt TEXT NOT NULL, settings TEXT NOT NULL /* JSON */, target_attachment_id TEXT, reference_ids TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL /* 'new' | 'edit_generated' | 'edit_upload' */, job_id TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER)`
  - `media_events(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, thread_id TEXT, message_id TEXT, model_id TEXT NOT NULL, mode TEXT, settings TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL, cost_estimated INTEGER NOT NULL DEFAULT 0, seconds REAL, duration_ms INTEGER, status TEXT NOT NULL CHECK (status IN ('complete','error')))`. It has indexes on `created_at` and `thread_id` and no foreign keys, so it is never deleted.

- [ ] **Step 1: Write the failing tests** in `db.test.ts`:
  - `creates media tables` (insert one row into each table).
  - `migrates existing rows`: build a DB with the current SCHEMA minus the new columns (copy the pattern the file already uses for older-schema tests), add a chat and a usage row, then `openDb`. Expect `kind === 'chat'` and `thread_kind === 'chat'`.
- [ ] **Step 2: Run** `npx vitest run server/test/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by adding the tables to SCHEMA and adding `ALTER TABLE` statements guarded by `PRAGMA table_info`, like the existing migrations.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS, and `npm run typecheck` is clean.
- [ ] **Step 5: Commit** `feat(server): schema for image and video threads`.

### Task 2: Image catalog parsing, pricing and settings (pure)

**Files:**
- Create: `shared/imageModels.ts`
- Test: `shared/imageModels.test.ts` (fixtures: save the live `/images/models` response and three `/endpoints` responses, for FLUX 3 Image, Nano Banana 2.1 and GPT Image 2.5 Flare, to `shared/fixtures/`, plus one FLUX.2 megapixel model)

**Interfaces:**
- Produces:
  - `interface ImagePrice { kind: 'image'; bySize: Record<string, number> /* variant (lowercased) → $ */ } | { kind: 'token'; perOutputToken: number; perInputImageToken: number | null } | { kind: 'megapixel'; perMp: number } | { kind: 'unknown' }`
  - `interface ImageModel { id: string; name: string; description: string; created: number | null; aspects: string[]; resolutions: string[]; qualities: string[]; transparent: boolean; maxRefs: number; minRefs: number; price: ImagePrice }`
  - `parseImageModel(listEntry: any, endpoints: any | null): ImageModel | null`. It returns null for SVG-only models and for models whose endpoints list is empty.
  - `TYPICAL_IMAGE_TOKENS: Record<string, number>`, keyed `'1k' | '2k' | '4k' | 'default'`, with the values 1290 / 1800 / 3600 / 1290. A quality multiplier for low/medium/high/xhigh/max is 0.25 / 1 / 2.5 / 4 / 6. *(These are the plan's documented estimate table; adjust them if the manual check shows they're far off.)*
  - `estimateImageCost(m: ImageModel, s: ImageSettings, history: number | null): { cost: number | null; estimated: boolean }`. When `history` is given (the user's average for this model + size + quality), it uses that, with `estimated: true`.
  - `interface ImageSettings { aspect: string; size: string | null; quality: string | null; transparent: boolean }`
  - `defaultSettings(m: ImageModel): ImageSettings` and `snapSettings(m: ImageModel, s: ImageSettings): ImageSettings`
  - `canGenerate(m: ImageModel, refs: number): string | null`. It returns the composer's block reason: "This model needs a photo to edit.", "This model can't edit images.", or "This model accepts up to N images."

- [ ] **Step 1: Write the failing tests:**
  - FLUX 3 Image: `price` is `{kind:'image', bySize:{'768':0.041,'1k':0.048,'1.5k':0.07,'2k':0.1,'4k':0.607}}`, and `estimateImageCost` at 1K is `{cost:0.048, estimated:false}`.
  - Nano Banana: token price; the estimate at 1K is `0.00003 × 1290 ≈ 0.0387`, `estimated: true`.
  - A megapixel model at 1024×1024 is `perMp × 1.048576` and is exact.
  - A model with no pricing gives `{kind:'unknown'}` and `cost: null`.
  - `parseImageModel` returns null for a Recraft SVG-only entry and for an endpoints response with `endpoints: []`.
  - `snapSettings`: `16:9` on a model without it becomes `1:1` (or the first entry); `4K` on a 2K-max model becomes `2K`; `quality: 'max'` on a model without quality becomes `null`.
  - `defaultSettings` picks `medium` quality for GPT Image 2.5 Flare.
  - `canGenerate` covers the four cases.
- [ ] **Step 2: Run** `npx vitest run shared/imageModels.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** For SVG-only detection, use `supported_parameters.output_format` (or the endpoint's) whose only value is `svg`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: image model catalog and pricing parser`.

### Task 3: OpenRouter client additions

**Files:**
- Modify: `server/src/openrouter.ts`
- Test: `server/test/openrouter.test.ts`

**Interfaces:**
- Consumes: `parseImageModel`, `ImageModel` (Task 2).
- Produces these on `OpenRouterClient`:
  - `listImageModels(): Promise<ImageModel[]>`. It fetches `/images/models`, then each model's `/endpoints` (at most 6 concurrent requests); a failed endpoint fetch gives `price: {kind:'unknown'}`.
  - `generateImage(o: { apiKey: string; model: string; prompt: string; settings: ImageSettings; references: string[] /* data URLs */ }): Promise<{ data: Buffer; mime: string; usage: Usage | null }>`. It sends `n: 1`, includes `resolution`/`quality`/`background` only when set, and uses `media_type`, or sniffs PNG/JPEG/WebP bytes, for `mime`. It throws `OpenRouterError` the same way `request` already does.

- [ ] **Step 1: Write the failing tests** with the existing fake-fetch pattern:
  - `generateImage` posts to `/images` with the exact body keys (no `quality` key when it's null), and decodes `b64_json`.
  - A 502 response throws `OpenRouterError` with status 502.
  - `listImageModels` skips SVG-only models.
- [ ] **Step 2: Run** `npx vitest run server/test/openrouter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Also add both methods to any test helper that builds a fake `OpenRouterClient` (`server/test/appHelpers.ts`), as stubs that throw "not scripted".
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): OpenRouter image generation client`.

### Task 4: Image catalog cache, media library, and threads by kind

**Files:**
- Create: `server/src/mediaLibrary.ts`, `server/src/routes/mediaModels.ts`
- Modify: `server/src/app.ts` (mount `/api/media-models`), `server/src/chats.ts` (`createChat(db, kind)`, `listChats(db, kind)`, totals include `media_events`), `server/src/routes/chats.ts` (`GET /api/chats?kind=`, `POST /api/chats {kind}`), `web/src/api.ts`
- Test: `server/test/mediaLibrary.test.ts`, `server/test/chats.test.ts`

**Interfaces:**
- Consumes: `listImageModels` (Task 3), the tables (Task 1).
- Produces:
  - `getMediaCatalog(db, openrouter, kind: 'image', refresh: boolean): Promise<{ models: ImageModel[]; fetchedAt: number; stale: boolean }>` (24h TTL; on fetch failure, returns the stale cache).
  - `listMediaLibrary(db, kind): MediaLibraryModel[]` (`{ id, displayName, kind, model: ImageModel | null /* from cache */, avgCost: Record<string, number> /* "size|quality" → avg $ from media_events */ }`), plus `addMediaModel` and `removeMediaModel`.
  - Routes:
    - `GET /api/media-models?kind=image`
    - `GET /api/media-models/catalog?kind=image[&refresh=1]`
    - `POST /api/media-models {id, kind}` (400 when the id isn't in the catalog)
    - `DELETE /api/media-models?id=&kind=`
  - `listChats(db, kind: ThreadKind)`: `totalCost` is the sum of `usage_events` plus `media_events` for that thread. Each `ChatSummary` gains `kind`, `thumbnailId: string | null` (the latest generated image attachment) and `busy: boolean` (any `media_generations` without `finished_at`).
  - The `api` client gains `listMediaModels(kind)`, `mediaCatalog(kind, refresh)`, `addMediaModel(id, kind)`, `removeMediaModel(id, kind)`, `listChats(kind)` and `createChat(kind)`.
- [ ] **Step 1: Write the failing tests:**
  - Adding the same id as an image model leaves `models` (the chat library) untouched.
  - `avgCost` averages only complete events for the size and quality.
  - `listChats(db,'image')` excludes chat threads and vice versa.
  - `totalCost` includes `media_events`.
  - `GET /api/chats` with no `kind` still returns only chats, so the existing client keeps working.
- [ ] **Step 2: Run** `npx vitest run server/test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): image model library and thread kinds`.

### Task 5: Image generation

**Files:**
- Create: `server/src/imageGen.ts`, `server/src/routes/images.ts`
- Modify: `server/src/app.ts`, `server/src/index.ts` (startup cleanup), `server/src/title.ts` (photo-only titles, `thread_kind` on its usage row), `server/src/usage.ts` (`threadKind` on `UsageEventInput`, default `'chat'`), `server/src/chats.ts` (`getChatDetail` adds `generations`)
- Test: `server/test/imageGen.test.ts`

**Interfaces:**
- Consumes: `generateImage` (Task 3), `snapSettings`/`canGenerate`/`ImageModel` (Task 2), `listMediaLibrary` and the catalog (Task 4), `resolveAttachmentIds`/`attachToMessage` (`server/src/attachments.ts`).
- Produces:
  - `POST /api/chats/:id/images` with body `{ prompt: string; modelId: string; settings: ImageSettings; targetAttachmentId: string | null; attachmentIds: string[]; parentId?: string /* Again: regenerate under this user message */ }`. It returns `202 { userMessageId, assistantMessageId }` immediately. It returns 409 when the thread already has an unfinished generation, and 400 with `canGenerate`'s reason.
  - `startImageGeneration(deps, o): { userMessageId: string; assistantMessageId: string }`. It inserts the user message (unless `parentId`), the assistant message with `status = 'generating'` and the `media_generations` row, then runs the call without awaiting it.
    - On success: insert an `attachments` row on the assistant message (`kind:'image'`, filename `${slug(title)}-${n}.png|jpg|webp`), set `complete`, `finished_at`, record `media_events` (complete, usage), and touch the chat.
    - On failure: set `error`, store `media_generations.error`, and record `media_events` with `status:'error'`, `cost: 0`.
    - If the thread was deleted meanwhile, skip the message writes and record `media_events` with `message_id: null`.
    - After the first success, call `maybeGenerateTitle`.
  - `mode`: `new` with no target; `edit_upload` when the target or a reference is a user-uploaded attachment; `edit_generated` otherwise.
  - `failInterruptedGenerations(db): number`, called in `index.ts` at startup. It marks `generating` messages `error` with "Interrupted. Not charged."
  - `ChatDetail.generations: Record<string /* assistant message id */, { modelId: string; settings: ImageSettings; mode: string; error: string | null; startedAt: number; finishedAt: number | null; targetAttachmentId: string | null; cost: number | null }>`
  - Title (in `title.ts`): when the first user message has no text but has an attachment, the title is `${basename without extension} edit` and there's no model call. Its usage row (when there is a call) has `thread_kind = 'image'`.
- [ ] **Step 1: Write the failing tests** with a fake client whose `generateImage` resolves or rejects on demand:
  - `saves image and logs usage`: after awaiting the pending promise (export a `pendingGenerations` set or a `whenIdle()` test hook), the message is `complete` with one image attachment, and `media_events` has one complete row with the cost.
  - `edits the chosen attachment`: the request's `references[0]` is the target attachment's data URL, and `mode === 'edit_generated'`.
  - `uploaded photo makes edit_upload`.
  - `rejects a second generation while one runs` (409).
  - `failure unlocks and logs zero cost`: the message is `error` and the event has `cost === 0`, `status === 'error'`.
  - `thread deleted mid-generation`: no throw, and one event with `message_id === null`.
  - `startup marks generating as error`.
  - `photo-only thread is titled from the file name`, with no OpenRouter title call.
  - `Again regenerates as a sibling` (`parentId` given: no new user message, and the new assistant message shares the parent).
- [ ] **Step 2: Run** `npx vitest run server/test/imageGen.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): image generation in threads`.

### Task 6: Stats views

**Files:**
- Modify: `server/src/stats.ts`, `server/src/routes/stats.ts`, `server/src/routes/chats.ts` (`/stats` for image threads), `shared/types.ts`
- Create: `server/src/mediaStats.ts`
- Test: `server/test/mediaStats.test.ts`, `server/test/statsRoutes.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/stats?view=chats|images&range=&tz=`. `view` defaults to `chats`. The chats view is computed from `usage_events` with `thread_kind = 'chat'`, so it's otherwise unchanged.
  - `computeMediaStats({ events, titleRows, range, now, tz, modelNames, kind }): MediaStatsResponse`
  - `MediaStatsResponse`:

    ```ts
    {
      range;
      tiles: { count; spend; avgCost; avgDurationMs; promptTokens; completionTokens; tokenModels /* models reporting tokens */; seconds? /* video */; avgCostPerSecond? /* video */; failures };
      heatmap; buckets: { key; label; count; cost }[];
      models: { id; name; count; spend; avgCost; avgDurationMs; promptTokens; completionTokens; failures; seconds? }[];
      modes: { new; editGenerated; editUpload } | null /* images only */;
      allSpend /* usage_events + media_events in range, every kind */;
    }
    ```

    `spend` includes the title calls with `thread_kind = 'image'`.
  - `StatsResponse` gains `allSpend`.
  - `GET /api/chats/:id/stats` for an image thread returns `MediaThreadStats { count; spend; avgCost; avgDurationMs; failures }`.
- [ ] **Step 1: Write the failing tests:**
  - Tiles from three events: two complete at $0.04 and $0.06 (durations 10s and 20s) and one error. Expect count 2, spend 0.10, avgCost 0.05, avgDurationMs 15000, failures 1.
  - Tokens are summed only from events that have them, and `tokenModels` counts those models.
  - `modes` split.
  - The chats view ignores a `thread_kind='image'` title row, and the images view includes it.
  - `allSpend` sums both tables.
  - The range filter works like the existing stats tests.
- [ ] **Step 2: Run** `npx vitest run server/test/mediaStats.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `rangeWindow`, `bucketKeys`, `heatmapDays` and `dayKey` from `statsTime.ts`.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): image stats`.

### Task 7: Copy generated items into chat attachments

**Files:**
- Modify: `server/src/routes/attachments.ts`, `server/src/attachments.ts`, `web/src/api.ts`
- Test: `server/test/attachments.test.ts`

**Interfaces:**
- Consumes: `fileVersions` / `parseFileBlocks` (file-generation plan).
- Produces:
  - `GET /api/attachments/generated` returns `{ images: { attachmentId; threadId; threadTitle; createdAt }[]; files: { chatId; chatTitle; messageId; name; size }[] }`, newest first. Images are attachments on assistant messages in `kind='image'` threads. Files are the latest version of each name per chat, on each chat's active path.
  - `POST /api/attachments/copy` with body `{ attachmentId }` or `{ messageId, name }` returns a new pending `Attachment`. A generated file becomes `kind:'text'` (mime from `mimeFor`), and the 1 MB text limit applies with the same error message. An image is copied as-is. The client shrinks oversized images *before* calling, via `POST /api/attachments` (multipart) instead of `copy`, when its bytes exceed 5 MB.
- [ ] **Step 1: Write the failing tests:**
  - `generated` lists an image from an image thread and the latest `p.html` from a chat.
  - `copy` of an image creates a pending attachment with the same bytes.
  - `copy` of a file creates a text attachment.
  - `copy` of an unknown id returns 404.
- [ ] **Step 2: Run** `npx vitest run server/test/attachments.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): attach generated images and files`.

### Task 8: Routes, sidebar mode switch, and Library switch (web)

**Files:**
- Modify: `web/src/lib/route.ts` (+ `route.test.ts`), `web/src/App.tsx`, `web/src/components/Sidebar.tsx`, `web/src/pages/ModelLibrary.tsx`, `web/src/styles.css`
- Create: `web/src/components/ImageModelCard.tsx`, `web/src/lib/imagePrice.ts` (+ test)

**Interfaces:**
- Produces:
  - `Route` adds `{ page: 'images'; threadId: string | null }`. The hashes are `#/images` and `#/images/:id`.
  - `formatImagePrice(m: ImageModel, avg: number | null): string`. Examples: `"$0.048 / image at 1K"`, `"~$0.039 / image"`, `"$0.03 / MP (~$0.031 at 1024×1024)"`, `"Price unknown"`. When `avg` is given, it appends `" · your avg $0.04"`.
- [ ] **Step 1: Write the failing tests**:
  - `parseHash('#/images/abc')` gives `{page:'images', threadId:'abc'}`.
  - `formatImagePrice`, one test per example above.
- [ ] **Step 2: Run** `npx vitest run web/src/lib`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The sidebar gets a **Chats / Images** segmented switch (reuse `components/stats/Segmented.tsx`), and the mode follows the route. In Images mode the list comes from `api.listChats('image')`, each row has a 26px thumbnail (`attachmentUrl(thumbnailId)`) and a spinner when `busy`, and "New" navigates to `#/images`. Search stays across all threads (*builder's call recorded: mixed results, each linking to its own mode*).
  - The Library gets a **Chat models / Image models** switch. The Image view has search, provider chips and cards, where each card shows its badges (Edits · up to N refs, Max 4K, Transparent, Needs a photo), the price line, and, when expanded, the description with "More on OpenRouter" (`https://openrouter.ai/${id}`), the size price table and the aspects. Add and remove use the media-model API.
- [ ] **Step 4: Check by hand** (the 3100/5174 setup). Switch modes, add Nano Banana 2.1 and FLUX 3 Image to the image list, and confirm the chat model picker is unchanged.
- [ ] **Step 5: Commit** `feat(web): Images mode in sidebar and image models in Library`.

### Task 9: Image thread view

**Files:**
- Create: `web/src/pages/ImageThread.tsx`, `web/src/components/ImageComposer.tsx`, `web/src/components/Lightbox.tsx`, `web/src/lib/shrinkImage.ts`
- Modify: `web/src/App.tsx`, `web/src/api.ts` (`generateImage(threadId, body)`), `web/src/styles.css`

**Interfaces:**
- Consumes: `POST /api/chats/:id/images`, `ChatDetail.generations` (Task 5); `estimateImageCost`, `defaultSettings`, `snapSettings`, `canGenerate` (Task 2); `listMediaLibrary` (Task 4).
- Produces:
  - `shrinkImage(file: Blob, maxBytes = 5 * MB): Promise<Blob>`. It is browser-only and uses canvas: it returns the input when it's under the limit, otherwise a JPEG at quality 0.9, then scaled down by 0.85 per step until it fits.
  - `lastImageModel` is stored in `localStorage` key `openchat.images.model`, wrapped in try/catch.
- [ ] **Step 1: Thread view.**
  - It shows user prompts (with thumbnails of the attached photos), then images with the meta line `Model · aspect · size · quality · $cost · Ns`.
  - Actions: Download, Edit this, Again (`parentId`). Sibling navigation reuses `SiblingNav`.
  - Clicking an image opens the lightbox.
  - `generating` shows a shimmer sized to the aspect ratio with `Generating… Ns`.
  - `error` shows the reason, "Not charged" when the cost is 0, and Retry.
  - While anything is generating, poll `getChat` every 2 s and stop when nothing is.
  - Creating the thread: the first Generate calls `createChat('image')` and then navigates.
- [ ] **Step 2: Composer.**
  - Prompt, paperclip (uploads go through `shrinkImage`), Model ▾ (image library), Aspect ▾, Size ▾ (hidden when there are no resolutions), Quality ▾ (only when offered), Transparent toggle (only when offered), and a "New image instead" toggle (shown only when there's an edit target).
  - The "Editing the image above" / "Editing image N" note.
  - **Generate · ~$0.04**, disabled with the `canGenerate` reason, while generating, or with an empty prompt and no photo. Settings snap on model change.
- [ ] **Step 3: Check by hand** with a **cheap** model (confirm with the user before the first paid call). Generate, edit twice, Again, upload a phone photo over 5 MB and edit it, leave the thread mid-generation and come back, and trigger a moderation failure if one comes up naturally (don't force one).
- [ ] **Step 4: Commit** `feat(web): image threads`.

### Task 10: Stats switch, thread popover, and "From my chats" picker (web)

**Files:**
- Modify: `web/src/pages/Stats.tsx`, `web/src/components/ChatStatsPopover.tsx` (or a sibling `MediaStatsPopover.tsx`), `web/src/components/AttachButton.tsx`, `web/src/api.ts`
- Create: `web/src/components/stats/MediaStats.tsx`, `web/src/components/GeneratedPicker.tsx`

**Interfaces:**
- Consumes: `GET /api/stats?view=images`, `MediaStatsResponse`, `MediaThreadStats` (Task 6); `GET /api/attachments/generated`, `POST /api/attachments/copy` (Task 7); `shrinkImage` (Task 9).
- [ ] **Step 1: Stats page.**
  - A **Chats / Images** switch, remembered in `localStorage` like the range.
  - The Images view has: tiles (the tokens tile is labeled "from models that report tokens"), the heatmap, a chart of count and cost, model rows, and the new-vs-edit split.
  - Both views show "All OpenChat spend in this range: $X".
  - The image thread header has a cost popover with `MediaThreadStats`.
- [ ] **Step 2: Attach menu.**
  - The chat composer's paperclip (and the edit box's) opens a menu: **From this computer** (the current picker) and **From my chats**.
  - The picker has Images (thumbnail grid) and Files (list), a search box over titles and names, and multi-select.
  - Confirming calls `copy` for each item. Images over 5 MB are fetched, shrunk, then uploaded instead. The results are added to the draft as uploaded attachments.
- [ ] **Step 3: Check by hand.**
  - The Images stats match the threads made in Task 9.
  - The Chats stats are unchanged from before this plan (compare against a screenshot taken at the start).
  - Attach a generated image and a generated HTML file to a chat. Ask for a brochure page using the image, and it shows in the file panel.
- [ ] **Step 4: Commit** `feat(web): image stats and attach from my chats`.
