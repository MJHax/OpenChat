import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeServer } from '../../test/fakeLocalServer';
import { createOllamaClient } from '../src/providers/ollama';
import { LocalServerError, ProviderError } from '../src/providers/types';
import { OpenRouterError, type StreamEvent } from '../src/openrouter';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const MODELS = [
  { name: 'qwen3:1.7b', tools: true, thinking: true, contextLength: 40960, sizeBytes: 1_400_000_000 },
  { name: 'gemma3:1b', contextLength: 32768 },
];
const start = async () => {
  server = await startFakeLocalServer({ flavor: 'ollama', models: MODELS });
  return createOllamaClient({ name: 'Ollama', baseUrl: server.url });
};
const collect = async (gen: AsyncGenerator<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};
const chatBody = () => server!.requests.find((r) => r.path === '/api/chat')!.body;
const hello = [{ role: 'user' as const, content: 'hi' }];

describe('ollama client', () => {
  it('lists models with capabilities', async () => {
    const client = await start();
    const models = await client.listModels();
    expect(models).toEqual([
      { name: 'qwen3:1.7b', sizeBytes: 1_400_000_000, contextLength: 40960, inputModalities: ['text'], supportsTools: true, supportsReasoning: true, capsKnown: true },
      { name: 'gemma3:1b', sizeBytes: 1_000_000_000, contextLength: 32768, inputModalities: ['text'], supportsTools: false, supportsReasoning: false, capsKnown: true },
    ]);
  });

  it('reports vision models as accepting images', async () => {
    server = await startFakeLocalServer({ flavor: 'ollama', models: [{ name: 'v', vision: true }] });
    const client = createOllamaClient({ name: 'Ollama', baseUrl: server.url });
    expect((await client.listModels())[0].inputModalities).toEqual(['text', 'image']);
  });

  it('streams reasoning, deltas and usage with cost 0', async () => {
    const client = await start();
    server!.reply({ thinking: ['hm'], text: ['Hel', 'lo'], promptTokens: 7, completionTokens: 2 });
    const events = await collect(
      client.streamChat({
        model: 'qwen3:1.7b',
        messages: hello,
        contextWindow: 16384,
        think: false,
        effort: 'high',
        webSearch: 'tool',
        plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }],
      }),
    );
    expect(events).toEqual([
      { type: 'reasoning', text: 'hm' },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'usage', usage: { promptTokens: 7, completionTokens: 2, cost: 0, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null } },
    ]);
    const body = chatBody();
    expect(body.stream).toBe(true);
    expect(body.options.num_ctx).toBe(16384);
    expect(body.think).toBe(false);
    const text = JSON.stringify(body);
    for (const word of ['plugins', 'usage', 'cache_control']) expect(text).not.toContain(word);
  });

  it('omits think and num_ctx when unset', async () => {
    const client = await start();
    await collect(client.streamChat({ model: 'gemma3:1b', messages: hello }));
    expect(chatBody()).not.toHaveProperty('think');
    expect(chatBody().options?.num_ctx).toBeUndefined();
  });

  it('yields tool calls after the stream', async () => {
    const client = await start();
    server!.reply({ toolCalls: [{ name: 'pass_to', arguments: { name: 'Ada' } }] });
    const tools = [{ name: 'pass_to', description: 'd', parameters: { type: 'object' } }];
    const events = await collect(client.streamChat({ model: 'qwen3:1.7b', messages: hello, tools }));
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', name: 'pass_to', arguments: '{"name":"Ada"}' });
    expect(events[events.length - 1].type).toBe('tool_call');
    expect(chatBody().tools).toEqual([{ type: 'function', function: tools[0] }]);
  });

  it('converts OpenAI-shaped messages', async () => {
    const client = await start();
    await collect(
      client.streamChat({
        model: 'gemma3:1b',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
              { type: 'text', text: 'please' },
            ],
          },
        ],
      }),
    );
    expect(chatBody().messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'look\nplease', images: ['QUJD'] },
    ]);
  });

  it('complete() makes a non-streaming request', async () => {
    const client = await start();
    server!.reply({ text: ['a', 'b'], promptTokens: 4, completionTokens: 2 });
    const usages: unknown[] = [];
    const text = await client.complete({ model: 'gemma3:1b', messages: hello, maxTokens: 50, contextWindow: 8192, onUsage: (u) => usages.push(u) });
    expect(text).toBe('ab');
    expect(chatBody()).toMatchObject({ stream: false, options: { num_ctx: 8192, num_predict: 50 } });
    expect(usages).toEqual([expect.objectContaining({ promptTokens: 4, completionTokens: 2, cost: 0 })]);
  });

  it('reports an unreachable server', async () => {
    const client = await start();
    const url = server!.url;
    await server!.close();
    server = undefined;
    const err = await client.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe(`Can't reach Ollama at ${url.replace('http://', '')}. Is it running?`);
    expect(err.status).toBe(0);
  });

  it('reports a failed request with the server detail', async () => {
    const client = await start();
    server!.failNext(500, 'model requires more system memory');
    const err = await collect(client.streamChat({ model: 'gemma3:1b', messages: hello })).catch((e) => e);
    expect(err).toBeInstanceOf(LocalServerError);
    expect(err.message).toBe("Ollama couldn't run this model: model requires more system memory");
    expect(err.status).toBe(500);
  });

  it('rejects with an AbortError when aborted mid-stream', async () => {
    const client = await start();
    server!.reply({ text: ['a', 'b', 'c', 'd'], delayMs: 100 });
    const ac = new AbortController();
    const gen = client.streamChat({ model: 'gemma3:1b', messages: hello, signal: ac.signal });
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'delta' });
    ac.abort();
    const err = await gen.next().catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('OpenRouterError is a ProviderError', () => {
    const e = new OpenRouterError('x', 401);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.name).toBe('OpenRouterError');
    expect(e.status).toBe(401);
  });
});
