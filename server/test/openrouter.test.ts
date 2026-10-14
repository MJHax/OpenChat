import { describe, it, expect } from 'vitest';
import { createOpenRouterClient, OpenRouterError } from '../src/openrouter';
import { streamOf, collect } from '../../test/helpers';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const sse = (...events: string[]) =>
  new Response(streamOf(...events.map((e) => `${e}\n\n`)), { headers: { 'Content-Type': 'text/event-stream' } });

describe('OpenRouter client', () => {
  it('lists models with numeric prices', async () => {
    const { fn } = fakeFetch(() => Response.json({
      data: [
        { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
        { id: 'openrouter/auto', name: 'Auto', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
        { id: 'x/y', name: 'Y' },
      ],
    }));
    const models = await createOpenRouterClient(fn).listModels();
    expect(models).toEqual([
      { id: 'openai/gpt-4o', name: 'GPT-4o', contextLength: 128000, promptPrice: 0.0000025, completionPrice: 0.00001 },
      { id: 'openrouter/auto', name: 'Auto', contextLength: 2000000, promptPrice: -1, completionPrice: -1 },
      { id: 'x/y', name: 'Y', contextLength: null, promptPrice: null, completionPrice: null },
    ]);
  });

  it('streams deltas and usage, skipping comments and [DONE]', async () => {
    const { fn, calls } = fakeFetch(() => sse(
      ': OPENROUTER PROCESSING',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":3,"cost":0.00042}}',
      'data: [DONE]',
    ));
    const events = await collect(createOpenRouterClient(fn).streamChat({
      apiKey: 'sk-test', model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 3, cost: 0.00042 } },
    ]);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'openai/gpt-4o', stream: true, usage: { include: true } });
  });

  it('turns HTTP errors into friendly OpenRouterErrors', async () => {
    const { fn } = fakeFetch(() => Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 }));
    const err = await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'bad', model: 'm', messages: [] })).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/API key/);
  });

  it('throws on a mid-stream error chunk after yielding earlier text', async () => {
    const { fn } = fakeFetch(() => sse(
      'data: {"choices":[{"delta":{"content":"Part"}}]}',
      'data: {"error":{"code":502,"message":"Provider disconnected"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}',
    ));
    const seen: string[] = [];
    const err = await (async () => {
      for await (const ev of createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [] })) {
        if (ev.type === 'delta') seen.push(ev.text);
      }
    })().catch((e) => e);
    expect(seen).toEqual(['Part']);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.message).toMatch(/Provider disconnected/);
  });

  it('reports network failures with status 0', async () => {
    const { fn } = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const err = await createOpenRouterClient(fn).listModels().catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.status).toBe(0);
  });

  it('complete() returns the message content', async () => {
    const { fn } = fakeFetch(() => Response.json({ choices: [{ message: { content: 'Trip ideas' } }] }));
    expect(await createOpenRouterClient(fn).complete({ apiKey: 'k', model: 'm', messages: [] })).toBe('Trip ideas');
  });

  it('checkKey() rejects an invalid key', async () => {
    const { fn, calls } = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(createOpenRouterClient(fn).checkKey('bad')).rejects.toBeInstanceOf(OpenRouterError);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/key');
  });
});
