import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

export interface FakeSearchResult {
  title: string;
  url: string;
  content: string;
}
export interface FakeSearch {
  url: string;
  requests: { method: string; path: string; query: Record<string, string>; body: any; auth: string | undefined }[];
  setResults(r: FakeSearchResult[]): void;
  setJson(on: boolean): void;
  failNext(status: number): void;
  hang(on: boolean): void;
  close(): Promise<void>;
}

const DEFAULT_RESULTS: FakeSearchResult[] = [
  { title: 'Cats - Wikipedia', url: 'https://en.wikipedia.org/wiki/Cat', content: 'The cat is a small domesticated carnivorous mammal.' },
  { title: 'Cat care guide', url: 'https://example.com/cat-care', content: 'How to look after a cat.' },
  { title: 'Cat facts', url: 'https://example.org/facts', content: 'Cats sleep for most of the day.' },
];

export async function startFakeSearchServer(o: { port?: number; json?: boolean; tavilyKey?: string } = {}): Promise<FakeSearch> {
  let results = DEFAULT_RESULTS.map((r) => ({ ...r }));
  let jsonOn = o.json ?? true;
  const tavilyKey = o.tavilyKey ?? 'tvly-test';
  let failure: number | undefined;
  let hanging = false;
  const requests: FakeSearch['requests'] = [];
  const sockets = new Set<Socket>();

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

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
    const u = new URL(req.url ?? '/', 'http://fake');
    const query = Object.fromEntries(u.searchParams);
    const auth = req.headers.authorization;
    requests.push({ method, path: u.pathname, query, body, auth });

    if (hanging) return; // accept but never answer
    if (failure !== undefined) {
      const status = failure;
      failure = undefined;
      return send(res, status, { error: 'failed' });
    }

    // SearXNG
    if (method === 'GET' && u.pathname === '/search') {
      if (query.format === 'json' && !jsonOn) return send(res, 403, '<html><body>Forbidden</body></html>', 'text/html');
      if (query.format !== 'json') return send(res, 200, '<html><body>results</body></html>', 'text/html');
      return send(res, 200, { query: query.q, results });
    }
    // Tavily
    if ((u.pathname === '/search' || u.pathname === '/usage') && auth !== `Bearer ${tavilyKey}`) {
      return send(res, 401, { detail: { error: 'Unauthorized' } });
    }
    if (method === 'POST' && u.pathname === '/search') {
      const max = typeof body?.max_results === 'number' ? body.max_results : results.length;
      return send(res, 200, { query: body?.query, results: results.slice(0, max).map((r) => ({ ...r, score: 0.9 })) });
    }
    if (method === 'GET' && u.pathname === '/usage') return send(res, 200, { key: { usage: 0, limit: 1000 } });
    send(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: String(err) });
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
    setResults(r) {
      results = r.map((x) => ({ ...x }));
    },
    setJson(on) {
      jsonOn = on;
    },
    failNext(status) {
      failure = status;
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

// Run as a script: npm run fake-search -- --port 8888 [--no-json] [--tavily-key <key>]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const s = await startFakeSearchServer({
    port: arg('port') ? Number(arg('port')) : undefined,
    json: !args.includes('--no-json'),
    tavilyKey: arg('tavily-key'),
  });
  console.log(`fake search server listening on ${s.url}`);
}
