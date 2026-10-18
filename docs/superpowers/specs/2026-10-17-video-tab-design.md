# Video Tab — Design Spec

**Date:** 2026-10-17
**Status:** Decisions approved in conversation (pending spec review)
**Builds on:** `2026-10-17-images-tab-design.md` (its sidebar mode switch, thread shell, Library switch, Stats switch, background-completion pattern and "From my chats" picker), `2026-10-16-usage-stats-design.md`

This is project 3 of 3. It is built after the Images tab and reuses most of it.

## Purpose

Make short clips from a prompt and, usually, the user's own photos. The user's first idea is a **cat video**: a starting photo and an ending photo of their cats, plus a request to generate the scene in between.

The user is **very cost-conscious**. If a clip is mostly right, they'll keep it rather than pay for another. Their order when it's wrong is: tweak the prompt and retry, and only switch models if that still fails. The design is built around knowing the price before pressing Generate, and making a cheap retry easy.

## Decisions made in conversation

The user approved the mockup `video-tab.html` and everything below:

- **A Video mode in the sidebar** (Chats / Images / **Video**), with video threads listed the same way as image threads.
- **Start and end photo slots** above the prompt. Photos come from the computer, "From my chats", or the Images tab.
- **The price is shown on the Generate button before you spend**, with a line breaking it down (`5s × $0.084/s at 720p = $0.42 · sound would add $0.21`).
- **Cheap defaults:** the shortest duration, 720p (or the lowest offered), and sound off.
- **"Tweak prompt & retry"** refills the composer with the same prompt and photos. Each try is a new clip in the thread, and each is charged separately.
- **Rendering keeps going in the background** ("safe to leave this page"), with a spinner on the sidebar thread and a notification when it's done.
- **No confirmation dialog.** The price on the button is the confirmation.
- **Stats:** a Video view with clips, seconds generated, spend, average cost per second, average render time and failures.

## Out of scope

- Models that take a **video as input**: editing, upscaling, avatars, and "reference" video (FLUX Video Edit, FLUX Video Upscale, Runway Aleph 2, HeyGen Avatar IV). *(My call: they need a video-upload flow and are a different use.)*
- Reference images other than first and last frame (`input_references`). *(My call; a later addition.)*
- Using videos in chat, or offering them in "From my chats".
- Cancelling a running job. OpenRouter's API offers no cancel.
- A "confirm over $X" setting. It was offered and not taken up.
- Webhooks. OpenChat is local, so it polls.

---

## OpenRouter facts this design rests on (checked 2026-10-17)

- **The job flow is asynchronous.**
  - `POST /api/v1/videos` with `model`, `prompt`, `duration`, `resolution`, `aspect_ratio` (or `size`), `frame_images` (first/last frame), `generate_audio` and `seed`. It returns 202 with a job id and a `polling_url`, which may be relative or absolute, so handle both.
  - `GET /api/v1/videos/{id}` returns the status: `pending`, then `completed`, `failed`, `cancelled` or `expired`. The docs suggest polling about every 30 seconds.
  - `GET /api/v1/videos/{id}/content?index=0` downloads the video, using the API key.
  - Sending unsupported values gets a 400 that lists the valid ones.
- `GET /api/v1/videos/models` lists **30** models. Each has `supported_durations`, `supported_resolutions`, `supported_aspect_ratios`, `supported_sizes`, `supported_frame_images` (`first_frame`, `last_frame`), `generate_audio` (`true`, `false` or `null`), `seed`, a description cut short with "...", and `pricing_skus`.
- **`pricing_skus` keys are free-form.** Seen so far:
  - `cents_per_video_output_second_720p` (cents per second, by resolution).
  - `cents_per_second_output`, `cents_per_second_output_4k`.
  - `duration_seconds`, `duration_seconds_with_audio`, `duration_seconds_without_audio_720p`, `text_to_video_duration_seconds_720p`, `image_to_video_duration_seconds_720p`. These are **dollars** per second. For example Kling 3.0 Std is `0.084`, and Veo 3.1 Lite without audio at 720p is `0.03`.
  - `video_tokens` and `video_tokens_without_audio` (Seedance: dollars per video token, not per second).
- The chat catalog shows `$0` for video models, which is why the chat catalog can't be used for prices.

---

## Sending photos: probe first (user's decision)

OpenRouter's docs only show `frame_images` as **public HTTPS URLs**. Data URLs aren't mentioned. OpenChat runs on `127.0.0.1`, so the user's photos have no public URL.

- **The first task of the plan is a probe.** The user approved spending about 15¢. Make one real call on the cheapest model that takes a start frame (4 s, 480p, sound off), with the start frame as a base64 data URL. Use the same call to check two more things: whether `usage.cost` is filled in on completed jobs, and the Seedance token formula, if that can be done within the budget, otherwise skip it. Write the results into this section.
- **If data URLs work** (on the probe model, and also tried on one other provider's start+end model when the budget allows): photos are sent as data URLs, after the same shrink-to-fit as the Images tab.
- **If they don't:** the user accepts a fallback where photos are uploaded to a **temporary public file host** for the job and deleted (or set to expire) as soon as the job ends. The user noted this adds complexity. Rules for the fallback:
  - Use it only for models that fail with data URLs.
  - Show a one-line notice in the composer: "Your photos will be uploaded briefly to <host> so the model can fetch them."
  - The host choice is the builder's, but it must support expiry or deletion and need no account the user doesn't already have.
  - If the probe shows the fallback is needed, **stop and check the host choice with the user** before building it.

### Probe results (2026-10-17, $0.17 spent, user-approved)

- **Data URLs work.** Grok Imagine Video 1.5 Lite (xAI, start frame, 2 s, 480p) and Veo 3.1 Lite (Google, start + end frame, 4 s, 720p) both accepted base64 PNG data URLs in `frame_images` and completed. **No temp-upload fallback is needed.**
- **`usage.cost` is filled in on completed jobs:** $0.05 and $0.12. Both match `videoPrice` exactly (2 × $0.02 + $0.01 photo fee; 4 × $0.03).
- **Each job finished in about 30 s.** Poll status went `pending` → `completed`. `polling_url` came back absolute (`https://openrouter.ai/api/v1/videos/<id>`).
- Completed jobs also return `urls` (signed, about 24 h) and `expires_at`. OpenChat downloads through `/content?index=0` with the key and never stores the signed URLs.
- Seedance token-formula check: skipped, to stay within budget. Seedance prices stay marked "~".

## Model Library

- The Library's switch gets a third option: **Chat / Image / Video models**.
- Video models browse `/videos/models`, cached like the image catalog, minus the out-of-scope video-input models. *(Builder's call how to detect those: no `supported_durations` together with no frame support, plus a deny-list for the four named models.)*
- **Card:**
  - The price per second at the cheapest resolution, sound off ("from $0.03/s").
  - Badges: **Start+end frames** or **Start frame**, **Sound** (when `generate_audio` is `true`), **Max 1080p** or **4K**, and the length range ("4–15s").
- **Expanded card:** the shortened description, a **More on OpenRouter** link, the full price table (resolution × sound), the durations and the aspect ratios.
- Adding works as for image models, as a separate list.

## Pricing (exact when possible)

- A shared parser turns `pricing_skus` into a lookup from **(resolution, sound on/off, has-start-frame) to dollars per second**:
  - `cents_*` keys are divided by 100.
  - Keys without a resolution apply to every resolution that has no more specific key.
  - `image_to_video_*` is used when a start frame is filled, `text_to_video_*` otherwise.
  - `*_with_audio` / `*_without_audio` select on the sound setting.
- When the lookup succeeds, the button shows the **exact** price, `duration × rate`, with no "~".
- **Token-priced models** (Seedance): the price is an estimate, shown with "~". It's calculated as `video_tokens` price × width × height × 24 fps × duration ÷ 1024, from the chosen `size`. *(The builder verifies this formula against one real call and records the result here. If it's more than 25% off, those models show "Price after generating" instead.)*
- **Other keys** *(my calls)*:
  - `cents_per_image_input` (Grok Imagine Video) is added once per filled photo slot, and the price stays exact.
  - `minimum_cents_per_generation` applies as a floor: `max(minimum, computed)`.
  - Keys that only apply to out-of-scope inputs are ignored, and the price stays exact. These are `reference_*`, `*_video_continuation_*`, `video_tokens_with_video_input` and `cents_per_megapixel_second_*`.
- Unknown key shapes that would apply to an in-scope request show "Price after generating", and the card shows "Price unknown". **Nothing guesses silently.**
- After a job, the **real** cost (from the job's usage, if OpenRouter reports it; otherwise the computed price, marked "est.") is stored and shown on the meta line.
- The breakdown line under the composer shows the formula and the extra cost of the next step up: sound on, and the next resolution.

## The Video tab

### Composer

- **Two photo slots: Start and End.** Each one is a drop target with a menu: From this computer, From my chats, From Images. These are the same sources and the same in-browser shrink-to-fit as the Images tab.
  - The End slot is disabled with a tooltip when the chosen model has only `first_frame`.
  - Both slots are disabled for models with no frame support.
- **Prompt box.**
- **Model ▾:** video models in the Library. Models that can't take the filled slots are greyed out with the reason.
- **Length ▾**, from `supported_durations` (default: the shortest).
- **Quality ▾**, from `supported_resolutions` (default: 720p, or the lowest offered when 720p isn't).
- **Aspect ▾:** defaults to the start photo's shape snapped to the nearest supported ratio, or `16:9` with no photo.
- **Sound toggle**, shown only when the model has `generate_audio: true`. It defaults **off**, and OpenChat always sends `generate_audio: false` unless the user turns it on, because the API defaults it to true.
- **Generate · $0.42**, with the breakdown line under it.
- **Validation before sending:** the values are checked against the model's lists. When a model change makes a value invalid, it snaps to the nearest valid value, and the breakdown says so.

### Thread

- Each try shows the user's prompt, with small start→end thumbnails, followed by the clip.
- **The clip** is an inline `<video controls>` with a poster from its first frame. Builder's call: let the browser draw it, or use the start photo.
- **Meta line:** `Kling 3.0 Std · 5s · 720p · no sound · $0.42 · 2m 40s`.
- **Actions:** **Download** (MP4, named after the thread) and **Tweak prompt & retry**. Retry fills the composer with that try's prompt, photos and settings, and focuses the prompt.
- **While rendering:** a shimmer placeholder at the chosen aspect shows "Rendering… 1m 12s", "usually N–M min · safe to leave this page", and the job status. N–M comes from the user's own past render times for that model, or "a few minutes" with no history.
- One job per thread at a time (the composer is locked while one is rendering). Other threads can render at the same time.
- **Failures** show OpenRouter's reason, whether it was charged (from usage, if reported), and a Retry button that refills the composer.

### Background jobs

- On Generate, the server submits the job and saves the assistant message as `rendering` with the job id, then returns at once.
- A **server-side poller** checks every pending job every 30 s, including after a restart: on startup it resumes polling any message still `rendering`.
  - On `completed`, it downloads the video, stores it, records usage, and marks the message `complete`.
  - On `failed`, `cancelled` or `expired`, it marks the message `error` with the reason.
  - *(My call: a paid clip must never be lost.)* OpenChat never gives up on its own. After 30 minutes, polling slows to every 5 minutes and the placeholder says "Taking longer than usual". Polling only stops at a final status from OpenRouter (`completed`, `failed`, `cancelled`, `expired`). On startup, every `rendering` job is checked immediately, however old it is. `pending` and `in_progress` both count as still running.
- **Video storage** *(builder's call)*: files on disk under `data/videos/<id>.mp4`, with a row pointing to them, are preferred over BLOBs because clips are tens of MB. Deleting a thread deletes its files.
- **The client:** an open thread polls its own status. The sidebar shows a spinner on threads with a rendering job (from the chat list's data).
- **The notification when a clip is done:**
  - A toast in OpenChat when the user is elsewhere in the app ("Cats meet on the couch is ready", clickable).
  - A browser notification when the tab is hidden, but only if the user has granted notification permission. OpenChat asks once, the first time they press Generate on a video.

## Stats

- The Stats page's switch gets **Video**, with the same ranges, chart and heatmap pattern as Images.
- **Tiles:** clips, seconds generated, total spend, average cost per second, average render time, failures.
- **Per-model rows:** clips, seconds, spend, average $/s, average render time, failures.
- **Per-thread popover** on the thread's total.
- Logged in `usage_events` (`purpose = 'video'`, plus seconds, resolution and sound). It is never deleted. Video-thread title calls count under Video. The "All OpenChat spend" line appears here too.

## Testing

- The pricing parser against every key shape listed above, using the live `/videos/models` response saved as a fixture. Test exact, token-estimated and unknown cases.
- The request builder: frame slots, defaults, snapping, and that `generate_audio: false` is always sent unless sound is on.
- The poller: completed, failed, expired, timeout, and resume after restart (using a fake OpenRouter client with scripted statuses).
- Storage cleanup when a thread is deleted.
- Usage logging and the stats queries.
- A manual check with the user's key on the cheapest start+end model at 720p, 4–5 s, sound off: two photos, generate, leave the page, get notified, play, then tweak and retry.

## Left to the builder

Styling, the poster frame, the toast design, the deny-list mechanics, the poll interval on the client, the exact snapping rules, the storage layout on disk, and how the render-time range is computed.
