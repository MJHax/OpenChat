# Images Tab — Design Spec

**Date:** 2026-10-17
**Status:** Decisions approved in conversation (pending spec review)
**Builds on:** `2026-10-14-openchat-design.md`, `2026-10-15-model-library-browse-design.md`, `2026-10-16-file-attachments-design.md`, `2026-10-16-usage-stats-design.md`, `2026-10-17-file-generation-design.md`

This is project 2 of 3. It comes after file generation (project 1), and project 3 (Video) reuses its shell. The "From my chats" attach picker below depends on project 1's generated files.

## Purpose

A place in OpenChat to generate and edit images. The user's habit, from ChatGPT: casual generations and modification requests, going **back and forth with changes** until it's right. The image being changed is either one the AI just made or a photo of their own ("a bit of both"). Pictures made here can also be used in chats, for example in a brochure built with project 1.

## Decisions made in conversation

- **A new sidebar mode.** The sidebar switches between **Chats / Images** (Video is added in project 3). In Images, it lists only image threads.
- **Threads work like the chat interface, specialised for generation:** an animation while an image generates, editing back and forth, and uploading your own photo to edit (approved from the mockup `images-tab.html`).
- **Thread titles** come from the first prompt's text, using the title model set in Settings for chats. A thread that starts with only a photo is named after the file ("IMG_2041 edit") with no model call.
- **Model Library:** image models get their **own list**. Cards show **price** and **what the model is good at**. The source for "good at fresh images vs edits" is **OpenRouter's description**, shown when a card is expanded. There are no hand-written labels or rankings.
- **Stats:** the Stats page gets a **Chats / Images** switch. Images shows tokens in/out (where reported), images generated, spend, and everything else listed under Stats below. The user approved the full list.
- **Using images in chat:** the chat composer's attach button offers **"From this computer"** (today's upload) and **"From my chats"**. The second picks any image made in the Images tab, or any file generated in a chat (project 1).

## Out of scope

- Live blurry-to-sharp previews (only OpenAI's image models stream them). Every model shows the same generating animation. *(My call.)*
- Several variants per generation (`n > 1`). It's always one image. *(My call; it multiplies cost.)*
- Masks or painting a region to edit.
- Generating images from the main chat.
- Video (project 3).
- Hand-curated quality labels or rankings.

---

## OpenRouter facts this design rests on (checked 2026-10-17)

- Image models have their own API: `POST /api/v1/images` with `model`, `prompt`, optional `aspect_ratio`, `resolution`, `input_references` (http(s) or base64 data URLs), `seed`, and `n`. The response is `data[].b64_json` plus `usage` (`cost`, with token counts for token-priced models only). It isn't conversational: each call stands alone.
- `GET /api/v1/images/models` lists **61** models. Each has `description`, `architecture`, and `supported_parameters` with enums for `resolution` and `aspect_ratio`, and ranges for `n` and `input_references`.
- `GET /api/v1/images/models/{id}/endpoints` gives per-provider pricing lines (`billable`, `unit`, `cost_usd`, `variant`):
  - Flat per image by size, for example FLUX 3 Image at 1K $0.048, 2K $0.10, 4K $0.607.
  - Per token, for example Nano Banana 2.1 and GPT Image 2.5, so there's no fixed per-image price.
- Only 2 of the 61 accept no reference images (`input_references.max == 0`), so they can't edit.
- Failed or blocked generations are not billed (they return 502).
- The plain `GET /models` that the app uses today shows only 12 image-capable models. That's why this tab needs the image endpoint.

---

## Model Library

- The Library page gets a **Chat models / Image models** switch.
- **Image models** browses OpenRouter's image-model list. It's cached like the chat catalog (24h TTL) in its own cache row, with the same search and provider chips. The capability filters below replace the chat ones.
- **Card:**
  - Name and provider.
  - **Three price kinds:** per image (by size variant), per token (estimated), and per **megapixel** (FLUX.2 Pro/Max/Flex/Klein). Megapixel prices show as "$X / MP (~$Y at 1024×1024)".
  - **Price:** a flat price at the default size ("$0.048 / image at 1K"), or "~$0.04 / image" (estimated) for token-priced models.
  - Once the user has generated with the model, the card also shows "your avg $0.039".
  - **Badges:** **Edits · up to N refs** (when `input_references.max > 0`), **Max 4K** (the top resolution), and **Transparent** (when a `background` parameter offers it).
- **Expanded card:** OpenRouter's full description, the price at every size, and the supported aspect ratios.
- The **"good at fresh vs edits"** judgment is the description. OpenChat adds no labels of its own.
- **Which models are listed** *(my calls)*:
  - Models whose only output format is SVG (the Recraft vector models) are left out for now, because SVG can carry scripts and chat models can't view it.
  - Models with no providers are hidden.
  - Models with no pricing show "Price unknown".
  - Models that need at least one reference image (`input_references.min >= 1`, for example Krea K3 Edit) get a **Needs a photo** badge, and the composer disables Generate until the thread has an edit target.
- **Description:** OpenRouter cuts every description off with "..." (in both list endpoints, and there is no single-model endpoint). The expanded card shows the shortened text plus a **More on OpenRouter** link to the model's openrouter.ai page.
- **Adding:** the same as chat models. The image list and the chat list are independent, so a model that is in both catalogs (for example Nano Banana 2.1) can be in either list, or both. *(Builder's call how to store it, for example a `kind` column with a composite key, or a separate table. The constraint is that the two lists don't interfere.)*
- **The estimate for token-priced models** *(my call)*: OpenChat's own average cost for that model and size once there's history. Before that, the output-token price × a typical token count per image at that size. It's always shown with "~". The builder picks the typical-token table and documents it.

## The Images tab

### Sidebar

- A **Chats / Images** segmented switch at the top of the sidebar. It follows the route: `#/images` and `#/images/:id` select Images.
- In Images mode, the list shows image threads with the same date groups, rename and delete as chats. Each row has a **thumbnail** of the thread's latest image.
- "New" creates an image thread. Model Library, Stats and Settings links stay the same.
- Search (FTS) covers image thread prompts. Builder's call whether results are mixed with chats or filtered by mode.

### Thread

- It reads like a chat: your prompt (with any photo you attached), then the image underneath.
- Under each image is a meta line, `Nano Banana 2.1 · 1:1 · 1K · $0.04 · 14s`, and three actions:
  - **Download** (PNG, or whatever format came back), named after the thread title and position.
  - **Edit this:** the next message edits this image.
  - **Again:** the same prompt and references, a fresh result. It shows as a sibling, using the existing branch navigation (`‹ 2/3 ›`).
- **Clicking an image** opens it full size (a lightbox) with the same actions.
- **While generating:** a shimmer placeholder sized to the chosen aspect ratio shows `Generating… Ns`. There is **no Stop**: OpenRouter can't cancel an image call, and the image is billed and saved when it lands. The thread's composer is locked until that generation finishes, so a thread runs one generation at a time. Other threads can generate at the same time. *(My call.)*
- **Errors** (including blocked content) show OpenRouter's message plus "Not charged" when the call failed, with a Retry button.

### Editing (the core loop)

- A new message **edits the thread's latest image by default**. An "Editing the image above" note appears above the generating placeholder.
- **Edit this** on an earlier image makes that image the target. The note then says "Editing image 2" and links to it. The target resets to the latest image after sending.
- **To start fresh**, the user opens a new thread *(my call)*. A small "New image instead" toggle in the composer turns off the edit target for one message.
- **Attaching a photo** (paperclip, the same upload rules as chat attachments) makes it the target. With several photos, all of them are sent as references (up to the model's `input_references.max`). If a message has more references than the model allows, the composer says so and disables Generate.
- **The request:** `prompt` is the user's message text, and `input_references` is the target image (plus any extra attached photos) as data URLs. Earlier prompts aren't resent *(my call)*: edit instructions like "give it a hat" work with the image alone, and this keeps every model on one code path, Nano Banana included.
- A model that can't edit (`max == 0`) disables "Edit this" and shows "This model can't edit images" in the composer when there's an edit target.

### Composer

- Prompt box, paperclip, and **Model ▾** (only the image models in the Library; defaults to the last one used).
- **Aspect ▾** (the model's enum, default `1:1`; `auto` when offered) and **Size ▾** (the model's resolutions, default `1K` or the model's smallest). Size is hidden for the 34 of 61 models that have no `resolution` parameter. Those models use their default size, the meta line omits the size, and the card has no "Max 4K" badge.
- **Quality ▾** (user's decision), only for models with a `quality` parameter (the OpenAI image models). It shows the model's own values and starts on **medium**, or the closest value when the model has no medium. The choice is stored on the message, shown in the meta line (`· medium`), and the estimate is keyed by quality as well as size.
- **Transparent** toggle, only when the model offers `background: transparent`. It sends `background` and is off by default.
- **Generate · ~$0.05.** The estimate updates with model and size.
- When the chosen model doesn't support the current aspect or size, the menu snaps to the nearest supported value.

### Keeps going in the background

- A generation runs to completion on the server even if the user leaves the thread or closes the tab. It's paid for either way, so the image is always saved.
- The assistant message is saved as `generating` when the call starts. Returning to the thread shows the placeholder, which resolves when the server finishes (the client polls the thread, or the builder chooses SSE).
- On server start, any message still `generating` becomes `error` ("Interrupted, not charged" if no usage was recorded).

### Storage

- Image threads reuse `chats` and `messages`, with a thread kind (`chat` | `image`) on `chats`.
- The image is an `attachments` row (`kind = 'image'`) on the assistant message.
- The edit target and references are recorded on the user message, so Again and branch navigation can reproduce the request.
- Generation settings (model, aspect, size, seed if returned) are stored on the assistant message.

## Stats

- The Stats page gets a **Chats / Images** switch. The existing page is the Chats view, unchanged.
- **Images view**, following the same range buttons (All time / Year / Month / Week / Today):
  - **Tiles:** images generated, total spent, average cost per image, average generation time, and tokens in / out. The tokens tile is labeled "from models that report tokens."
  - **Chart** of images and spend over time, plus the activity heatmap (last 12 months, image activity).
  - **Per-model rows:** images, spend, average cost, average time, tokens in/out (or "—"), and failures.
  - **New vs edit split:** fresh images, edits of generated images, and edits of uploaded photos.
- **Per-thread popover** on the thread header's total, like chats: images, spend, average cost and time, and failures.
- **Which view counts what** *(my call)*: title calls for image threads count under Images, as background cost. Chat replies, chat titles and memory count under Chats, as they do now. Both views show a small "All OpenChat spend in this range: $X" line, so the total still matches the OpenRouter bill.
- Every image call is logged in `usage_events`, which is never deleted (a new `purpose = 'image'` plus the fields needed above). Deleting a thread keeps its stats. Failed calls are logged with $0 cost.

## Using images and files in chat ("From my chats")

- The chat composer's attach button opens a small menu: **From this computer** (today's file picker) and **From my chats**.
- **From my chats** opens a picker with two sections:
  - **Images:** every image generated in the Images tab, newest first, as a thumbnail grid.
  - **Files:** every file generated in chats (project 1's latest version of each, by chat), as a list.
  - A search box filters both by thread or chat title and file name. Multi-select.
- Picking copies the item into a new pending attachment (images as `image`, generated files as `text`), so it behaves exactly like an upload. It counts toward the same limits, gets the same chips, and is sent the same way.
- In a project-1 HTML file, the model can use an attached image by its file name, as already specified there.
- Videos aren't offered (project 3 can extend this).
- **Size limit** *(my call)*: generated images are stored as they arrive, with no upload limit, because they don't go through the upload route. When one is picked for a chat and it's over the 5 MB image limit, the browser re-encodes it (canvas to JPEG, scaled down until it fits) before creating the attachment. The same in-browser shrink applies to photos uploaded in the Images tab, so big phone photos just work.

## Testing

- Parsing image catalog and endpoint pricing (flat, per-token, multiple variants) into card prices and estimates.
- The request builder: prompt plus target, extra references, the over-limit check, a model that can't edit, and snapping aspect and size.
- Background completion: the client goes away mid-call and the image is still saved; startup cleanup of stuck `generating` rows.
- Usage logging for success and failure; stats queries for each tile, the per-model rows and the new-vs-edit split.
- "From my chats" picker: images and generated files become pending attachments.
- A manual check with a real key and a cheap model: generate, edit twice, Again, upload a photo and edit it, then attach a generated image to a chat and use it in a project-1 HTML page.

## Left to the builder

Styling, the shimmer animation, the lightbox, the thumbnail size, the typical-token table for estimates, polling vs SSE for background results, the exact storage shape for kinds and references, and whether search mixes threads.
