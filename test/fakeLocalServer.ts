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
}
export interface FakeReply {
  text?: string[];
  thinking?: string[];
  toolCalls?: { name: string; arguments: object }[];
  delayMs?: number;
  promptTokens?: number;
  completionTokens?: number;
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

export async function startFakeLocalServer(o: { flavor: Flavor; models: FakeModel[]; port?: number }): Promise<FakeServer> {
  const { flavor } = o;
  let models = o.models.map((m) => ({ ...m }));
  const loadedWindow = new Map<string, number>();
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

  const nextReply = (): FakeReply => {
    if (!replies.length) return { text: ['ok'] };
    const r = replies[Math.min(replyIndex, replies.length - 1)];
    replyIndex++;
    return r;
  };

  async function chatOllama(res: ServerResponse, r: FakeReply) {
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
      load_duration: 1_000_000,
      prompt_eval_count: r.promptTokens ?? 1,
      eval_count: r.completionTokens ?? 1,
      eval_duration: 1_000_000,
    });
    res.end();
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
      return flavor === 'ollama' ? chatOllama(res, r) : chatOpenAI(res, r);
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
          return json(res, 200, {
            models: models.map((m) => {
              const win = loadedWindow.get(m.name) ?? (m.loaded ? ctx(m) : undefined);
              return {
                type: m.vision ? 'vlm' : 'llm',
                key: m.name,
                id: m.name,
                display_name: m.name,
                size_bytes: m.sizeBytes ?? 1_000_000_000,
                max_context_length: ctx(m),
                loaded_instances: win === undefined ? [] : [{ id: m.name, config: { context_length: win } }],
                capabilities: m.tools ? ['tool_use'] : [],
              };
            }),
          });
        }
        if (method === 'POST' && path === '/api/v1/models/load') {
          const m = find(body?.model);
          if (!m) return sendError(res, 404, `model '${body?.model}' not found`);
          loadedWindow.set(m.name, body?.context_length ?? ctx(m));
          return json(res, 200, { type: 'llm', instance_id: m.name, status: 'loaded' });
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
  const s = await startFakeLocalServer({
    flavor,
    port,
    models: [
      { name: 'qwen3:1.7b', tools: true, thinking: true, contextLength: 40960 },
      { name: 'gemma3:1b', contextLength: 32768 },
    ],
  });
  s.reply({ text: ['This is ', 'a reply from ', 'the fake ', 'local server.'], delayMs: 50 });
  console.log(`fake ${flavor} server listening on ${s.url}`);
}
