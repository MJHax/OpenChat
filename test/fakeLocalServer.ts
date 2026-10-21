import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

export interface FakeModel {
  name: string;
  sizeBytes?: number;
  contextLength?: number;
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
  loaded?: boolean;
  /** Pause before the first chunk the first time the model is used while unloaded; it is loaded afterwards. */
  loadMs?: number;
}
export interface FakeReply {
  text?: string[];
  thinking?: string[];
  toolCalls?: { name: string; arguments: object }[];
  delayMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Generation time the server reports, in ms (default 100). */
  evalMs?: number;
}
export interface FakeServer {
  url: string;
  requests: { method: string; path: string; body: any }[];
  reply(r: FakeReply): void;
  setModels(models: FakeModel[]): void;
  failNext(status: number, error: string): void;
  hang(on: boolean): void;
  close(): Promise<void>;
}

type Flavor = 'ollama' | 'lmstudio' | 'openai';
const DEFAULT_CONTEXT = 4096;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeLocalServer(o: { flavor: Flavor; models: FakeModel[]; port?: number; listDelayMs?: number }): Promise<FakeServer> {
  const { flavor } = o;
  let models = o.models.map((m) => ({ ...m }));
  const loadedWindow = new Map<string, number>();
  // Ollama only: models in memory, with the num_ctx they were last run with.
  const ollamaLoaded = new Map<string, number>();
  for (const m of models) if (flavor === 'ollama' && m.loaded) ollamaLoaded.set(m.name, DEFAULT_CONTEXT);
  let replies: FakeReply[] = [];
  let replyIndex = 0;
  let failure: { status: number; error: string } | undefined;
  let hanging = false;
  const requests: FakeServer['requests'] = [];
  const sockets = new Set<Socket>();

  const ctx = (m: FakeModel) => m.contextLength ?? DEFAULT_CONTEXT;
  const find = (name: unknown) => models.find((m) => m.name === name);

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const sendError = (res: ServerResponse, status: number, error: string) =>
    json(res, status, flavor === 'ollama' ? { error } : { error: { message: error, type: 'error' } });

  /** Marks the model loaded and returns how long that took (0 when it already was). LM Studio's own load call does its sleeping itself. */
  async function useModel(name: unknown, window?: number): Promise<number> {
    const m = find(name);
    if (!m || flavor === 'openai') return 0;
    if (flavor === 'ollama') {
      const win = window ?? ctx(m);
      const warm = ollamaLoaded.get(m.name) === win;
      if (warm) return 0;
      if (m.loadMs) await sleep(m.loadMs);
      ollamaLoaded.set(m.name, win); // reported by /api/ps only once loading has finished
      return m.loadMs ?? 0;
    }
    if (loadedWindow.has(m.name) || m.loaded) return 0;
    if (m.loadMs) await sleep(m.loadMs);
    loadedWindow.set(m.name, ctx(m));
    return m.loadMs ?? 0;
  }

  const nextReply = (): FakeReply => {
    if (!replies.length) return { text: ['ok'] };
    const r = replies[replyIndex];
    if (replyIndex < replies.length - 1) replyIndex++;
    return r;
  };

  async function chatOllama(res: ServerResponse, r: FakeReply, stream: boolean, loadMs: number) {
    if (!stream) return chatOllamaOnce(res, r, loadMs);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const line = (v: unknown) => res.write(JSON.stringify(v) + '\n');
    const created_at = new Date().toISOString();
    const pieces: object[] = [
      ...(r.thinking ?? []).map((t) => ({ role: 'assistant', content: '', thinking: t })),
      ...(r.text ?? []).map((t) => ({ role: 'assistant', content: t })),
    ];
    if (r.toolCalls?.length) {
      pieces.push({
        role: 'assistant',
        content: '',
        tool_calls: r.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      });
    }
    for (const message of pieces) {
      if (r.delayMs) await sleep(r.delayMs);
      line({ model: 'fake', created_at, message, done: false });
    }
    line({
      model: 'fake',
      created_at,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      total_duration: 2_000_000,
      load_duration: Math.max(loadMs, 1) * 1_000_000,
      prompt_eval_count: r.promptTokens ?? 1,
      eval_count: r.completionTokens ?? 1,
      eval_duration: (r.evalMs ?? 100) * 1_000_000,
    });
    res.end();
  }

  /** Real Ollama answers `stream: false` with one object: the whole message plus the final line's fields. */
  async function chatOllamaOnce(res: ServerResponse, r: FakeReply, loadMs: number) {
    if (r.delayMs) await sleep(r.delayMs);
    const message: Record<string, unknown> = { role: 'assistant', content: (r.text ?? []).join('') };
    if (r.thinking?.length) message.thinking = r.thinking.join('');
    if (r.toolCalls?.length) {
      message.tool_calls = r.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    }
    json(res, 200, {
      model: 'fake',
      created_at: new Date().toISOString(),
      message,
      done: true,
      done_reason: 'stop',
      total_duration: 2_000_000,
      load_duration: Math.max(loadMs, 1) * 1_000_000,
      prompt_eval_count: r.promptTokens ?? 1,
      eval_count: r.completionTokens ?? 1,
      eval_duration: (r.evalMs ?? 100) * 1_000_000,
    });
  }

  async function chatOpenAI(res: ServerResponse, r: FakeReply) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake' };
    const send = (choice: object, extra: object = {}) =>
      res.write(`data: ${JSON.stringify({ ...base, choices: [choice], ...extra })}\n\n`);
    send({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null });
    for (const t of r.thinking ?? []) {
      if (r.delayMs) await sleep(r.delayMs);
      send({ index: 0, delta: { reasoning_content: t }, finish_reason: null });
    }
    for (const t of r.text ?? []) {
      if (r.delayMs) await sleep(r.delayMs);
      send({ index: 0, delta: { content: t }, finish_reason: null });
    }
    if (r.toolCalls?.length) {
      if (r.delayMs) await sleep(r.delayMs);
      send({
        index: 0,
        delta: {
          tool_calls: r.toolCalls.map((c, index) => ({
            index,
            id: `call_${index}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        },
        finish_reason: null,
      });
    }
    const p = r.promptTokens ?? 1;
    const c = r.completionTokens ?? 1;
    send(
      { index: 0, delta: {}, finish_reason: r.toolCalls?.length ? 'tool_calls' : 'stop' },
      { usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } },
    );
    res.write('data: [DONE]\n\n');
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    requests.push({ method, path, body });

    if (hanging) return; // accept but never answer

    const isChat =
      method === 'POST' && (flavor === 'ollama' ? path === '/api/chat' : path === '/v1/chat/completions');
    if (isChat) {
      if (failure) {
        const f = failure;
        failure = undefined;
        return sendError(res, f.status, f.error);
      }
      const r = nextReply();
      const loadMs = await useModel(body?.model, body?.options?.num_ctx);
      return flavor === 'ollama' ? chatOllama(res, r, body?.stream !== false, loadMs) : chatOpenAI(res, r);
    }

    if (flavor === 'ollama') {
      if (method === 'GET' && path === '/api/tags') {
        return json(res, 200, {
          models: models.map((m) => ({
            name: m.name,
            model: m.name,
            modified_at: '2026-01-01T00:00:00Z',
            size: m.sizeBytes ?? 1_000_000_000,
            details: { format: 'gguf', family: 'fake', parameter_size: '1B', quantization_level: 'Q4_K_M' },
          })),
        });
      }
      if (method === 'GET' && path === '/api/ps') {
        return json(res, 200, {
          models: models
            .filter((m) => ollamaLoaded.has(m.name))
            .map((m) => ({ name: m.name, model: m.name, context_length: ollamaLoaded.get(m.name) })),
        });
      }
      if (method === 'POST' && path === '/api/show') {
        const name = body?.model ?? body?.name;
        const m = find(name);
        if (!m) return json(res, 404, { error: `model '${name}' not found` });
        return json(res, 200, {
          capabilities: [
            'completion',
            ...(m.tools ? ['tools'] : []),
            ...(m.vision ? ['vision'] : []),
            ...(m.thinking ? ['thinking'] : []),
          ],
          model_info: { 'general.architecture': 'fake', 'fake.context_length': ctx(m) },
        });
      }
    } else {
      if (method === 'GET' && path === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.name, object: 'model', owned_by: 'fake' })),
        });
      }
      if (flavor === 'lmstudio') {
        if (method === 'GET' && path === '/api/v1/models') {
          if (o.listDelayMs) await sleep(o.listDelayMs);
          return json(res, 200, {
            models: models.map((m) => {
              const win = loadedWindow.get(m.name) ?? (m.loaded ? ctx(m) : undefined);
              return {
                type: 'llm',
                key: m.name,
                display_name: m.name,
                size_bytes: m.sizeBytes ?? 1_000_000_000,
                max_context_length: ctx(m),
                loaded_instances: win === undefined ? [] : [{ id: m.name, config: { context_length: win } }],
                capabilities: { vision: !!m.vision, trained_for_tool_use: !!m.tools },
              };
            }),
          });
        }
        if (method === 'POST' && path === '/api/v1/models/load') {
          const m = find(body?.model);
          if (!m) return sendError(res, 404, `model '${body?.model}' not found`);
          if (m.loadMs) await sleep(m.loadMs);
          loadedWindow.set(m.name, body?.context_length ?? ctx(m));
          return json(res, 200, { type: 'llm', instance_id: m.name, load_time_seconds: (m.loadMs ?? 100) / 1000, status: 'loaded' });
        }
      }
    }
    sendError(res, 404, 'not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, 500, String(err));
      else res.end();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply(r) {
      // Queue the reply: each chat request consumes the next one, the last repeats.
      replies.push(r);
    },
    setModels(next) {
      models = next.map((m) => ({ ...m }));
    },
    failNext(status, error) {
      failure = { status, error };
    },
    hang(on) {
      hanging = on;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
    },
  };
}

// Run as a script: npm run fake-local -- --flavor ollama --port 11434
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flavor = (arg('flavor') ?? 'ollama') as Flavor;
  const port = arg('port') ? Number(arg('port')) : undefined;
  const loadMs = arg('load-ms') ? Number(arg('load-ms')) : undefined;
  const s = await startFakeLocalServer({
    flavor,
    port,
    models: [
      { name: 'qwen3:1.7b', tools: true, thinking: true, contextLength: 40960, loadMs },
      { name: 'gemma3:1b', contextLength: 32768, loadMs },
    ],
  });
  s.reply({ text: ['This is ', 'a reply from ', 'the fake ', 'local server.'], delayMs: 50 });
  console.log(`fake ${flavor} server listening on ${s.url}`);
}
