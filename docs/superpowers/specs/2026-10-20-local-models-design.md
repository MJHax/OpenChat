# Local models: design

## Why

OpenChat only talks to OpenRouter today, so it needs an OpenRouter account, credits and an API key before it does anything. The people most likely to find it as an open-source, self-hosted app (home labs, r/selfhosted, r/LocalLLaMA) often run models on their own machines with Ollama or LM Studio and expect a chat app to use them. Supporting local models lets OpenChat run with **no OpenRouter key at all**: free, private and offline. It also turns OpenChat from an app tied to one vendor into one with a clean provider layer, which is part of its value as a portfolio piece.

## Goals

- **OpenRouter becomes optional.** With no key, every text mode works on local models: chat (send, edit, regenerate, fork, continue), Compare, Discussions, web search, attachments, titles, memory suggestions and summaries. With a key, everything works as it does today, and local and OpenRouter models can be mixed freely, including inside one Compare or one Discussion.
- **Local servers** are set up in Settings. Ollama and LM Studio on the same machine are found automatically; any other server, such as Ollama on another machine on the network, can be added by address.
- **The Model Library** shows local models next to OpenRouter's catalog, marked by where they come from, and the user adds them to My models the same way as today.
- **Local stats:** each local reply records tokens per second, time to first token and model load time. These appear on the reply and on the Stats page.
- **Web search without OpenRouter**, through SearXNG (self-hosted) or Tavily (API key).
- **Clear local states:** a model loading into memory, a server that's offline, and a model that's been deleted from the server each show a plain message instead of hanging or failing with a raw error.
- **A fake local server** for automated tests, also runnable by hand to try the UI without a real server.
- **Built in four stages** (see "Build stages"), each one usable and tried by the user before the next begins.

## Non-goals

- **Downloading, deleting or managing models from OpenChat.** The user downloads models with Ollama or LM Studio. OpenChat only lists what's already on the server.
- **Local image and video generation.** The Images and Video tabs keep using OpenRouter. With no key they show "Needs an OpenRouter key" and a link to Settings. This includes SVG image models for now.
- **Brave Search and Ollama's web search.** Search is built so another service can be added later, but only SearXNG and Tavily ship now.
- **Docker, a login screen, or listening on the network.** Those are a separate project. OpenChat still only listens on `127.0.0.1`. (OpenChat connecting *out* to a server on another machine is in scope; other machines connecting *to* OpenChat is not.)
- **A desktop app or installer.**

## Anti-goals

- **Silent forgetting.** A local model must never quietly drop the start of a long chat because the server's context window is smaller than OpenChat thinks. See "Context window".
- **Looking frozen.** A first reply that waits on a model loading into memory must say so.
- **Raw connection errors.** "fetch failed" or "ECONNREFUSED" must never reach the user. An offline server reads as "Can't reach Ollama at localhost:11434. Is it running?"
- **Breaking what works.** Existing users with a key must see no change in behavior, stored data, model ids, stats or costs.
- **Local usage counting as spending.** Local replies cost $0 and never count toward spending limits.

## Decided by the user

- OpenChat must work fully with no OpenRouter key, in every text mode. OpenRouter stays as an option.
- Only models already downloaded through Ollama or LM Studio are used. No downloading in OpenChat.
- Images and Video say they need OpenRouter for now.
- Search uses **SearXNG and Tavily**.
- Local replies show **tokens per second** and other useful local stats.
- **Discussions:** several different local models may share one server. The user is warned that turns may be slow, not blocked.
- A **fake local server** script is used for automated tests.
- **A chat that outgrows a local model's window is never sent silently.** The send asks first, offering Summarize and continue or Send anyway, and a reply sent anyway is marked. See "Context window".
- **A chat that only used local models never goes to OpenRouter** for a title, memory suggestion or summary. See "Background helpers".
- The work is **built in stages**. The user has Ollama on their Windows PC with `qwen3:1.7b` (supports tools and thinking) and `gemma3:1b` (no tools) to try each stage.

## Design

### Providers and local servers

There are two kinds of provider: **OpenRouter** (one, needs a key) and **local servers** (any number). A local server has:

- a **type**: `ollama`, `lmstudio`, or `openai` (any other server that speaks the OpenAI chat API, such as llama.cpp's server or vLLM)
- a **name** the user sees ("Ollama", "Gaming PC")
- a **base address** (`http://localhost:11434`)
- whether it was **found automatically** or added by hand
- whether it's **enabled**

Servers are stored in the database and included in data export, import and wipe.

**Server identity (my call):** each server has a stable internal id, and local model ids are built from it (see "Model ids").
- **Editing** a server's name or address keeps its id, so a PC that gets a new IP address keeps all its chats, stats and My models entries.
- **Removing** a server takes its models out of My models the same way `removeModel` does today, including clearing them as the default, title or memory model. Chats, messages and stats keep their history, as they do when an OpenRouter model is removed today. The server's row is kept, marked removed, rather than deleted.
- **Adding it back**, either by hand with the same type and address or through "Look for local servers", restores the removed row and its id, so old chats line up with its models again.

**Auto-detection:** when the server starts, and when the user opens Settings → Models or the Model Library, OpenChat checks `http://localhost:11434` (Ollama) and `http://localhost:1234` (LM Studio). If one answers and isn't already listed, it's added as an automatic server named "Ollama" or "LM Studio". An automatic server that stops answering stays in the list and shows as offline; it is not removed. The user can disable or remove it. A removed automatic server is not re-added unless the user asks (a "Look for local servers" button).

**Talking to each type** (the builder confirms the exact endpoints against current docs and the real servers):

- **Ollama:** use Ollama's own API (`/api/tags`, `/api/show`, `/api/chat`) rather than its OpenAI-compatible endpoint. Only the native API lets OpenChat set the context window (`num_ctx`), turn thinking on or off, and read load and generation timings.
- **LM Studio:** the OpenAI-compatible `/v1/chat/completions` for replies, and LM Studio's own REST API for model details (context length, capabilities, loaded state) and per-reply stats where available.
- **Other OpenAI-compatible servers:** `/v1/models` and `/v1/chat/completions` only. Capabilities aren't known, so the user sets "supports tools" and "supports images" on the model in My models. Both default to off.

On the server side this sits behind the existing `OpenRouterClient`-style interface (`server/src/openrouter.ts:138`): one client per provider type, picked from the model's id. Every mode that calls `streamChat` or `complete` today goes through that choice and doesn't need to know which provider it's talking to.

### Model ids

OpenRouter model ids stay exactly as they are, so existing chats, messages, usage events and settings need no migration. Local model ids carry the server and the server's model name in a form that can never be mistaken for an OpenRouter id. The exact format is the builder's call. It must survive model names with `:` and `/` in them (`qwen3:1.7b`, `lmstudio-community/...`), and it must stay stable when the server is renamed, so it uses the server's internal id, not its display name.

### Settings

Settings gets a **Models** section (in the General tab or a new tab; builder's call) with:

- **OpenRouter:** the existing key field, now marked optional. Text under it: "Optional. Needed for OpenRouter models, images and video."
- **Local servers:** a list showing each server's name, address, type and status (online and how many models, or offline), with Edit, Disable and Remove. "Add server" asks for type, name and address, and tests the connection before saving. "Look for local servers" runs auto-detection again.
- **Web search:** a choice of None, SearXNG (address), or Tavily (API key, masked like the OpenRouter key). See "Web search".

### First run and "no key" messages

The current "Add your OpenRouter API key in Settings" hints (`web/src/components/ChatView.tsx:455`, `web/src/components/discussion/DiscussionSetup.tsx:67`) change. A key is no longer required, so the only blocking state is "no models". With no models in My models, the hint reads: "Add a model in the Model Library to start chatting. You can use an OpenRouter key, or a local server like Ollama or LM Studio." If a local server was detected, the hint says so ("Ollama found with 2 models") and links straight to the Model Library's local section.

Anything that needs OpenRouter (Images, Video, OpenRouter models in the picker if the key is later removed) says "Needs an OpenRouter key" with a link to Settings, instead of failing when used.

### Model Library

- The library gets a **source filter**: All, OpenRouter, and one entry per local server.
- **Local models** list each model on each enabled server with its name, size on disk, context length and capabilities (tools, images, thinking), and an **Add** button like OpenRouter models. They have no price; they show "Free · local" instead.
- Without an OpenRouter key, the OpenRouter catalog still shows (the catalog needs no key) but each Add button reads "Needs key". The builder may instead hide it behind a note; either way, adding an OpenRouter model without a key is not possible.
- **My models** shows a source badge on each model (OpenRouter, or the server's name). Local models show an **Offline** badge when their server isn't answering and **Not installed** when the server answers but no longer has the model. Both stay in My models, keep their chats, and can be removed. They're greyed out in the model picker and can't be sent to.
- For a local model, My models also shows the **context window** OpenChat will use, which the user can change (see below).
- Capabilities (`supports_tools`, `input_modalities`, `supports_reasoning`, `context_length`) are filled from the server's own report when the model is added, then refreshed when the library is opened, so the existing checks that read them (`server/src/library.ts:40-64`) work unchanged.

### Context window

Ollama often runs a model with a context window far smaller than the model supports, and quietly drops the start of the conversation when it's exceeded. To prevent that:

- Each local model in My models has a **context window** setting. The default is the smaller of the model's maximum and **16,384 tokens** (my call: large windows use a lot of memory, and 16k is safe on most machines while being enough for most chats). The user can raise it to the model's maximum.
- For Ollama, OpenChat **sends that number as `num_ctx` on every request**, so the window Ollama uses always matches what OpenChat assumes.
- For **LM Studio**, the window is fixed when the model is loaded. If the model isn't loaded when a reply is requested, OpenChat loads it through LM Studio's REST API with the user's context window setting (my call). If it's already loaded, OpenChat uses the window LM Studio reports.
- For **other OpenAI-compatible servers**, OpenChat can't see or set the window, so it uses the user's setting and trusts it.
- The existing context ring uses this number, so the user sees the chat filling up.
- **Check before sending (decided by the user):** before any local reply is requested, OpenChat estimates whether the prompt fits the window. If it doesn't, the send doesn't go straight through. The user gets: "This chat is longer than qwen3:1.7b can remember." with **Summarize and continue** (the existing feature) and **Send anyway**. This applies wherever a local model replies: send, edit, regenerate, Compare, Discussion turns and continue. In Compare and Discussions, where several models reply, the question names the models that won't fit.
- **Send anyway** sends the request, and the reply carries a visible note: "Earlier messages were dropped because the chat is longer than this model's memory." The note is stored with the message so it survives a reload.
- The estimate doesn't need to be exact. The builder picks the method (for example the server's own token count from the previous reply plus an estimate for the new message) and errs toward asking.

### Replies from local models

- **Model loading:** if a reply has no first token after about 2 seconds and the server says the model isn't loaded yet (Ollama and LM Studio both report this), the reply shows "Loading qwen3:1.7b into memory…" until the first token arrives. If the server can't say, the message is "Waiting for the model…" after 5 seconds.
- **Thinking:** models that report thinking support get the existing reasoning display. The reasoning picker shows On/Off for local thinking models instead of OpenRouter's effort levels (my call). Models that support effort levels (such as `gpt-oss`) may show them; builder's call.
- **Errors:** every connection failure maps to a plain message naming the server and its address. Server-side errors (out of memory, model failed to load) show the server's own message under "Ollama couldn't run this model:".
- **Stopping** a reply cancels the request to the local server, as it does for OpenRouter.
- **OpenRouter-only request fields** (prompt caching markers from `withCacheMarkers`, OpenRouter plugins, OpenRouter's web search tool) are never sent to local servers.

### Attachments

- **Images:** sent to local models that report image support, using the server's own format. A model without image support can't receive them, the same rule as OpenRouter models today.
- **PDFs:** OpenRouter models keep the PDF plugin. For local models, OpenChat extracts the PDF's text itself and adds it to the message. The extraction library is the builder's call. A scanned PDF with no text says "This PDF has no readable text" instead of sending nothing.
- **Text and code files** work as today.

### Stats

- `usage_events` gains columns for **load time**, **generation time** and **tokens per second** (or the inputs needed to compute it; builder's call). They're filled for local replies and left empty for OpenRouter ones. Time to first token already exists (`first_token_ms`).
- Local events have `cost` 0 and are excluded from spending-limit totals, so limits only ever count OpenRouter spending.
- **Spending limits never block local models (my call).** The checks that run before a request today (`checkSpend` and `spendBlock`, used in `server/src/routes/generate.ts`, `routes/discussions.ts`, `discussion/summary.ts`, `title.ts` and `memorySuggest.ts`) only apply when the model is an OpenRouter model. In a mixed Compare that hits a limit, the OpenRouter replies fail with the limit error as they do today and the local replies carry on. In a Discussion, the existing pause for a reached limit only happens when it's an OpenRouter participant's turn.
- **On the reply:** the per-reply details OpenChat already shows gain tokens/sec, time to first token and load time for local replies.
- **On the Stats page:** a Local vs OpenRouter split of replies and tokens, and for local models, average tokens/sec and average time to first token per model. Exactly how it's laid out is the builder's call, following the existing Stats page style.
- The chat header's cost chip stays. A chat that only used local models shows $0.00.

### Web search

- **OpenRouter models** keep OpenRouter's search exactly as today.
- **Local models** use the search service chosen in Settings:
  - **SearXNG:** the user enters their instance's address. SearXNG only answers in JSON if `json` is turned on in its settings, so the connection test checks for that and, if it's off, explains which line to change.
  - **Tavily:** the user enters an API key.
- Two ways to search, matching today's two modes (`server/src/openrouter.ts:81`):
  - **Model supports tools:** the model gets a `web_search` function. OpenChat runs the search and returns the results, at most 3 searches per reply (today's cap).
  - **Model doesn't support tools:** OpenChat searches with the user's message before the model replies and adds the top results to the prompt.
- Results become the reply's **sources** the same way OpenRouter's citations do today, so the existing sources display works.
- With no search service set, the search toggle is disabled for local models and its tooltip says "Set up web search in Settings".
- Search services sit behind a small interface (search a query, return title, address and text) so Brave or others can be added later.

### Discussions

- Only the **moderator** uses tools (`pass_to`, `end_discussion`, `server/src/discussion/engine.ts:52`), so any local model can be an ordinary participant. The existing rule that the moderator needs a tool-capable model (`server/src/discussion/store.ts:69`) applies to local models using their reported tool support. `gemma3:1b` can't moderate; `qwen3:1.7b` can.
- **One model, many participants:** using the same local model for every participant needs no model switching. The setup screen mentions this when a local model is picked: "Tip: one local model can play every participant. Give each one different instructions."
- **Different local models on the same server:** allowed, with a warning under the participant list: "These models share one server, so each turn may wait while the next model loads." Not shown for models on different servers or OpenRouter models.
- **Moderator that doesn't steer:** small models often fail to call tools. If the moderator finishes a turn with no valid tool call, the discussion falls back to the normal speaking order, as today. After two such turns in a row, a note appears once in the discussion: "The moderator isn't choosing speakers, so the normal order is being used."
- Summaries and the printed report work with any model, as today.

### Compare

Compare runs several models at the same time. Local models on the **same server** run **one after another** instead, in the order they appear, so they don't fight over memory. OpenRouter models and models on other servers still run at the same time. A note above the compare replies says "Local models on the same server reply one at a time."

### Background helpers

Chat titles and memory suggestions use the model chosen in Settings. If none is chosen, titles fall back to the chat's own model (`server/src/title.ts:61`) and memory suggestions to the default model (`server/src/memorySuggest.ts:27`). Local models can be picked for either.

**Local chats stay local (decided by the user).** A chat in which every reply came from a local model is never sent to OpenRouter:
- Its **title** is made by the chat's own model when the chosen title model is an OpenRouter model.
- **Summarize and continue** and Discussion **summaries** already use a model the user picks for that chat. If the user picks an OpenRouter model for a local-only chat, that's their explicit choice and is allowed.
- **Memory suggestions** take what the user typed, not a chat, so they follow the chosen memory model as today.
- Settings says so under the title model choice: "Chats that only used local models are titled by their own model, so they never leave your machine."

If a helper model is offline, a title is skipped (the chat keeps its default title) and a memory suggestion shows the offline error. Nothing falls back to OpenRouter on its own.

### Fake local server for tests

A small script in `test/` that pretends to be Ollama and LM Studio, started on a random port by the tests:

- lists configured models with configurable capabilities (tools, images, thinking, context length)
- streams replies made up of fixed text, with configurable delay, a configurable "loading" pause before the first token, and stats in each server's own format
- returns tool calls when a test asks for them, so search and Discussion moderation can be tested
- can act offline, return server errors, or drop a model between requests

It can also be **run by hand** (an npm script) on Ollama's or LM Studio's usual port, so the UI can be tried without a real server.

Automated tests cover every local path against this fake server. Real-server behavior is checked by the user at the end of each stage on their own PC.

## Build stages

Each stage ends with automated tests passing against the fake server, then the user trying it with real Ollama.

1. **Providers, Model Library and chat.** Local server storage and auto-detection, Settings → Models, OpenRouter optional, local models in the Model Library and My models, model ids, the client for each server type, the context window and the check before sending, chat replies (send, edit, regenerate, fork, continue), thinking, background helpers (including local chats titled locally), new first-run and "needs a key" messages, Images and Video gated on the key, and the fake server.
2. **Local stats and states.** Load time and tokens/sec recorded and shown, Stats page split, spending limits ignoring local use, loading/offline/not-installed states, plain error messages, image and PDF attachments for local models.
3. **Web search.** Settings for SearXNG and Tavily, both search modes for local models, sources.
4. **Discussions and Compare.** Moderator capability check for local models, the one-model tip, the same-server warning, the moderator note, one-at-a-time Compare on a shared server.

## Left to the builder

- Exact local model id format, within the constraints above.
- Where the Models section sits in Settings.
- Database layout for servers and the new stats columns, following the existing migration style in `server/src/db.ts`.
- How the provider clients are split into files.
- The PDF text extraction library.
- Exact endpoint usage for each server type, confirmed against current Ollama and LM Studio docs.
- Stats page layout for the new numbers.
- Whether effort levels show for local models that support them.
