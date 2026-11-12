![OpenChat](docs/brand/banner.png)

# OpenChat

**A self-hosted chat app for [OpenRouter](https://openrouter.ai) and your own local models.**

Chat with hundreds of cloud models through one OpenRouter key, or stay fully offline with [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), with no account or key needed.

![OpenChat chatting with a local model](docs/screenshots/chat.png)

## Highlights

### Compare models side by side

Send one message to up to four models at once, local and cloud mixed. Each reply shows its tokens, speed and cost, and you pick the one to continue with.

![Three local models answering the same question side by side](docs/screenshots/compare.png)

### Let models debate

Start a **Discussion**: give each model a name and a position, add an optional moderator who hands out the floor, and watch them argue. You can step in at any point, add more turns, or have the debate summarized.

![A moderator hands the floor between two models debating tabs versus spaces](docs/screenshots/discussion.gif)

### Know what you're spending

Every reply shows its cost, token count and speed. The Stats page breaks down spending and usage by model and over time, and spending limits stop OpenRouter requests once you hit your budget.

### Private by default

Chats that only use local models never go to OpenRouter, not even to write their title. Your chats, files and settings stay in one SQLite file on your machine.

### Lightweight

`npm install && npm start` and you're running. No database server and no Docker required (though a Docker setup is included).

### Also included

- Edit and regenerate messages, with every version kept
- Fork a chat, or summarize it and continue in a fresh one
- Attach images, PDFs and text files
- Web search (OpenRouter's, or SearXNG / Tavily for local models)
- Image and video generation
- Memories, custom instructions and saved prompts
- Export and import all your data as one zip

## Set up

You need [Node.js](https://nodejs.org) 22.12 or newer.

```bash
git clone https://github.com/MJHax/OpenChat.git
cd OpenChat
npm install
npm start
```

Open http://127.0.0.1:3000.

## Add models

Pick one or both:

- **Local models (free, private):** install [Ollama](https://ollama.com) and download a model, for example `ollama pull qwen3:1.7b`. In OpenChat, open **Model Library** and click **Add** on the model.
- **Cloud models:** create a key at [openrouter.ai/keys](https://openrouter.ai/keys), paste it in **Settings → General → OpenRouter**, then add models from the **Model Library**.

## Run it on a home server

To use OpenChat from other devices on your network, run it with Docker:

```bash
git clone https://github.com/MJHax/OpenChat.git
cd OpenChat
docker compose up -d
```

Open `http://<server address>:3000` from any device on your network. To update, run `git pull`, then `docker compose up -d --build`.

> [!WARNING]
> OpenChat has no login. Anyone who can reach it can read your chats and use your OpenRouter credit. Only run it on a network you trust, and never expose it to the internet. See [SECURITY.md](SECURITY.md).

## Back up or move your data

In **Settings → Data**, use **Export all data** to save a backup and **Import a backup** to restore it on another machine.

## License

[MIT](LICENSE)
