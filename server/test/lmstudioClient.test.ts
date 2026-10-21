import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeModel, type FakeServer } from '../../test/fakeLocalServer';
import { createLmStudioClient } from '../src/providers/lmstudio';
import { createOpenAICompatClient } from '../src/providers/openaiCompat';
import { LocalServerError } from '../src/providers/types';
import type { StreamEvent } from '../src/openrouter';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const collect = async (gen: AsyncGenerator<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};
const hello = [{ role: 'user' as const, content: 'hi' }];
const chatBody = () => server!.requests.find((r) => r.path === '/v1/chat/completions')!.body;
const loads = () => server!.requests.filter((r) => r.path === '/api/v1/models/load');
const ZERO_COST = { cost: 0, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null };
const QWEN = 'lmstudio-community/Qwen3-8B-GGUF';

const LM_MODELS: FakeModel[] = [
  { name: QWEN, contextLength: 40960, tools: true, sizeBytes: 5_000_000_000 },
  { name: 'vision-model', vision: true, contextLength: 8192, loaded: true },
];
const startLm = async () => {
  server = await startFakeLocalServer({ flavor: 'lmstudio', models: LM_MODELS });
  return createLmStudioClient({ name: 'LM Studio', baseUrl: server.url });
};
const startOpenAI = async () => {
  server = await startFakeLocalServer({ flavor: 'openai', models: [{ name: 'gpt-local' }, { name: 'other' }] });
  return createOpenAICompatClient({ name: 'My server', baseUrl: server.url });
};

/** Answers with headers at once, then never finishes the body (until the request is aborted). */
const stalledBody: typeof fetch = async (_url, init) =>
  new Response(new ReadableStream({ start: (c) => init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)) }), { status: 200 });

describe('LM Studio client', () => {
  it('sends tool calls and results back in the OpenAI shape', async () => {
    const client = await startLm();
    server!.reply({ text: ['ok'] });
    await collect(
      client.streamChat({
        model: QWEN,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"cats"}' }] },
          { role: 'tool', content: 'result', toolCallId: 'call_1', toolName: 'web_search' },
        ],
      }),
    );
    const messages = (chatBody() as any).messages;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"cats"}' } }],
    });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result' });
  });

  it('reads a stalled model listing as unreachable', async () => {
    const client = createLmStudioClient({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234' }, stalledBody);
    await expect(client.listModels()).rejects.toThrow("Can't reach LM Studio at 127.0.0.1:1234. Is it running?");
  });

  it('chats on when the model listing before the chat stalls, skipping the load step', async () => {
    await startLm();
    const real = fetch;
    const fetchImpl: typeof fetch = (input, init) => (String(input).endsWith('/api/v1/models') ? stalledBody(input, init) : real(input, init));
    const client = createLmStudioClient({ name: 'LM Studio', baseUrl: server!.url }, fetchImpl);
    server!.reply({ text: ['ok'] });
    const events = await collect(client.streamChat({ model: QWEN, messages: hello, contextWindow: 4096 }));
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(loads()).toHaveLength(0);
  }, 15_000);

  it('lists models with capabilities', async () => {
    const client = await startLm();
    expect(await client.listModels()).toEqual([
      { name: QWEN, sizeBytes: 5_000_000_000, contextLength: 40960, inputModalities: ['text'], supportsTools: true, supportsReasoning: false, capsKnown: true },
      { name: 'vision-model', sizeBytes: 1_000_000_000, contextLength: 8192, inputModalities: ['text', 'image'], supportsTools: false, supportsReasoning: false, capsKnown: true },
    ]);
  });

  it('skips embedding models', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          models: [
            { type: 'embedding', key: 'emb', size_bytes: 1, max_context_length: 2048, loaded_instances: [] },
            { type: 'llm', key: 'chat', loaded_instances: [], capabilities: {} },
          ],
        }),
      );
    const client = createLmStudioClient({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1' }, fetchImpl);
    expect((await client.listModels()).map((m) => m.name)).toEqual(['chat']);
  });

  it('loads an unloaded model once with the context window, then chats', async () => {
    const client = await startLm();
    server!.reply({ text: ['Hel', 'lo'], promptTokens: 7, completionTokens: 2 });
    const events = await collect(
      client.streamChat({
        model: QWEN,
        messages: hello,
        contextWindow: 16384,
        effort: 'high',
        webSearch: 'tool',
        plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }],
      }),
    );
    expect(loads()).toHaveLength(1);
    expect(loads()[0].body).toEqual({ model: QWEN, context_length: 16384 });
    const paths = server!.requests.map((r) => r.path);
    expect(paths.indexOf('/api/v1/models/load')).toBeLessThan(paths.indexOf('/v1/chat/completions'));
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'usage', usage: { promptTokens: 7, completionTokens: 2, ...ZERO_COST, loadMs: expect.any(Number) } },
    ]);
    expect(chatBody().model).toBe(QWEN);
    expect(chatBody().stream).toBe(true);
    expect(chatBody().stream_options).toEqual({ include_usage: true });
    expect(chatBody()).not.toHaveProperty('tools');
    const text = JSON.stringify(chatBody());
    for (const word of ['plugins', 'reasoning', 'cache_control', 'max_tool_calls']) expect(text).not.toContain(word);
  });

  it('does not load a model that is already loaded', async () => {
    const client = await startLm();
    await collect(client.streamChat({ model: 'vision-model', messages: hello, contextWindow: 16384 }));
    expect(loads()).toHaveLength(0);
    await collect(client.streamChat({ model: QWEN, messages: hello, contextWindow: 16384 }));
    await collect(client.streamChat({ model: QWEN, messages: hello, contextWindow: 16384 }));
    expect(loads()).toHaveLength(1);
  });

  it('sends tools only when given, and yields tool calls last', async () => {
    const client = await startLm();
    server!.reply({ toolCalls: [{ name: 'pass_to', arguments: { name: 'Ada' } }] });
    const tools = [{ name: 'pass_to', description: 'd', parameters: { type: 'object' } }];
    const events = await collect(client.streamChat({ model: 'vision-model', messages: hello, tools }));
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', name: 'pass_to', arguments: '{"name":"Ada"}' });
    expect(chatBody().tools).toEqual([{ type: 'function', function: tools[0] }]);
  });

  it('strips cache markers and keeps images as image_url parts', async () => {
    const client = await startLm();
    await collect(
      client.streamChat({
        model: 'vision-model',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
          { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
        ],
      }),
    );
    expect(chatBody().messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
    ]);
  });

  it('complete() returns the text and reports usage', async () => {
    const client = await startLm();
    server!.reply({ text: ['a', 'b'], promptTokens: 4, completionTokens: 2 });
    const usages: unknown[] = [];
    const text = await client.complete({ model: 'vision-model', messages: hello, maxTokens: 50, onUsage: (u) => usages.push(u) });
    expect(text).toBe('ab');
    expect(chatBody().max_tokens).toBe(50);
    expect(usages).toEqual([expect.objectContaining({ promptTokens: 4, completionTokens: 2, cost: 0 })]);
  });

  it('reports an unreachable server', async () => {
    const client = await startLm();
    const url = server!.url;
    await server!.close();
    server = undefined;
    const err = await client.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe(`Can't reach LM Studio at ${url.replace('http://', '')}. Is it running?`);
    expect(err.status).toBe(0);
  });

  it('reports a failed chat with the server detail', async () => {
    const client = await startLm();
    server!.failNext(500, 'model requires more system memory');
    const err = await collect(client.streamChat({ model: 'vision-model', messages: hello })).catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe("LM Studio couldn't run this model: model requires more system memory");
    expect(err.status).toBe(500);
  });

  it('rejects with an AbortError when aborted mid-stream', async () => {
    const client = await startLm();
    server!.reply({ text: ['a', 'b', 'c', 'd'], delayMs: 100 });
    const ac = new AbortController();
    const gen = client.streamChat({ model: 'vision-model', messages: hello, signal: ac.signal });
    expect((await gen.next()).value).toMatchObject({ type: 'delta' });
    ac.abort();
    const err = await gen.next().catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('says the connection was lost when the server drops mid-reply', async () => {
    const client = await startLm();
    server!.reply({ text: ['a', 'b', 'c'], cutAfter: 1 });
    const err = await collect(client.streamChat({ model: 'vision-model', messages: hello })).catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe(`Lost the connection to LM Studio at ${new URL(server!.url).host}.`);
  });

  it('says a model is not installed when the listing no longer has it', async () => {
    const client = await startLm();
    server!.setModels([]);
    const err = await collect(client.streamChat({ model: QWEN, messages: hello, contextWindow: 4096 })).catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe(`${QWEN} isn't installed on LM Studio any more.`);
    expect(err.status).toBe(404);
  });
});

describe('OpenAI-compatible client', () => {
  it('says the connection was lost when the server drops mid-reply', async () => {
    const client = await startOpenAI();
    server!.reply({ text: ['a', 'b', 'c'], cutAfter: 1 });
    const err = await collect(client.streamChat({ model: 'gpt-local', messages: hello })).catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe(`Lost the connection to My server at ${new URL(server!.url).host}.`);
  });

  it('still rejects with an AbortError when aborted mid-stream', async () => {
    const client = await startOpenAI();
    server!.reply({ text: ['a', 'b', 'c', 'd'], delayMs: 100 });
    const ac = new AbortController();
    const gen = client.streamChat({ model: 'gpt-local', messages: hello, signal: ac.signal });
    expect((await gen.next()).value).toMatchObject({ type: 'delta' });
    ac.abort();
    const err = await gen.next().catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('lists models with unknown capabilities', async () => {
    const client = await startOpenAI();
    expect(await client.listModels()).toEqual([
      { name: 'gpt-local', sizeBytes: null, contextLength: null, inputModalities: ['text'], supportsTools: false, supportsReasoning: false, capsKnown: false },
      { name: 'other', sizeBytes: null, contextLength: null, inputModalities: ['text'], supportsTools: false, supportsReasoning: false, capsKnown: false },
    ]);
  });

  it('streams deltas and usage with cost 0, never loading', async () => {
    const client = await startOpenAI();
    server!.reply({ text: ['Hi', '!'], promptTokens: 3, completionTokens: 1 });
    const events = await collect(client.streamChat({ model: 'gpt-local', messages: hello, contextWindow: 8192 }));
    expect(events).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'delta', text: '!' },
      { type: 'usage', usage: { promptTokens: 3, completionTokens: 1, ...ZERO_COST } },
    ]);
    expect(server!.requests.map((r) => r.path)).toEqual(['/v1/chat/completions']);
    expect(chatBody()).toMatchObject({ model: 'gpt-local', stream: true, stream_options: { include_usage: true } });
  });

  it('reports errors from the server', async () => {
    const client = await startOpenAI();
    server!.failNext(401, 'bad key');
    const err = await collect(client.streamChat({ model: 'gpt-local', messages: hello })).catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe("My server couldn't run this model: bad key");
    expect(err.status).toBe(401);
  });

  it('says "unknown error" when an error chunk carries no message', async () => {
    const sse = 'data: {"error":{"code":500}}\n\ndata: [DONE]\n\n';
    const fetchImpl: typeof fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const client = createOpenAICompatClient({ name: 'My server', baseUrl: 'http://127.0.0.1:1' }, fetchImpl);
    const err = await collect(client.streamChat({ model: 'gpt-local', messages: hello })).catch((e) => e);
    expect(err.message).toBe("My server couldn't run this model: unknown error");
  });
});

describe('LM Studio load timings', () => {
  const startTimed = async (o: { listDelayMs?: number } = {}) => {
    server = await startFakeLocalServer({
      flavor: 'lmstudio',
      listDelayMs: o.listDelayMs,
      models: [
        { name: 'cold', contextLength: 8192, loadMs: 200 },
        { name: 'warm', contextLength: 8192, loaded: true },
      ],
    });
    return createLmStudioClient({ name: 'LM Studio', baseUrl: server.url });
  };
  const usageOf = async (client: ReturnType<typeof createLmStudioClient>, model: string) =>
    ((await collect(client.streamChat({ model, messages: hello, contextWindow: 4096 }))).find((e) => e.type === 'usage') as any).usage;

  it('reports the load time when the pre-chat step loads the model, null otherwise', async () => {
    const client = await startTimed();
    const cold = await usageOf(client, 'cold');
    expect(Math.abs(cold.loadMs - 200)).toBeLessThanOrEqual(50);
    expect(cold.generationMs).toBeNull();
    expect((await usageOf(client, 'warm')).loadMs).toBeNull();
    expect((await usageOf(client, 'cold')).loadMs).toBeNull();
  });

  it('reports the loaded window in loadState', async () => {
    const client = await startTimed();
    expect(await client.loadState('cold')).toEqual({ loaded: false, contextWindow: null });
    expect(await client.loadState('warm')).toEqual({ loaded: true, contextWindow: 8192 });
    await usageOf(client, 'cold');
    expect(await client.loadState('cold')).toEqual({ loaded: true, contextWindow: 4096 });
  });

  it('resolves loadState null when the listing fails', async () => {
    const client = await startTimed();
    await server!.close();
    server = undefined;
    expect(await client.loadState('cold')).toBeNull();
  });

  it('gives up on a slow listing after 1.5 s in loadState', async () => {
    const client = await startTimed({ listDelayMs: 2000 });
    const started = Date.now();
    expect(await client.loadState('cold')).toBeNull();
    expect(Date.now() - started).toBeLessThan(1900);
  });

  it('waits up to 10 s for a slow pre-chat listing before the load request', async () => {
    const client = await startTimed({ listDelayMs: 2000 });
    await usageOf(client, 'cold');
    expect(loads()).toHaveLength(1);
  }, 15_000);
});

describe('OpenAI-compatible load state', () => {
  it('cannot say whether a model is loaded', async () => {
    const client = await startOpenAI();
    expect(await client.loadState('gpt-local')).toBeNull();
  });
});
