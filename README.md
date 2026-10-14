# OpenChat

A local, single-user chat app in the style of Claude.ai that talks to any model on [OpenRouter](https://openrouter.ai).

## Setup

```bash
npm install
```

Add your OpenRouter key either in the app (Settings → OpenRouter API key) or in a `.env` file:

```bash
cp .env.example .env
```

## Run

```bash
npm start
```

Open http://127.0.0.1:3000. For development with hot reload use `npm run dev` and open http://localhost:5173.

## Use

1. **Model Library** → search the OpenRouter catalog → **Add** the models you want.
2. Start a chat; switch models from the picker any time.
3. **Regenerate** any reply with any model, or **Edit** your message — every version is kept; flip with ‹ ›.
4. **Settings** → About me, custom instructions and memories are added to every chat.

Data lives in `data/openchat.db` (SQLite). Delete it to start fresh.

## Scripts

- `npm test` — server and helper tests (Vitest)
- `npm run typecheck` — TypeScript
