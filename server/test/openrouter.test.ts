import { describe, it, expect } from 'vitest';
import { createOpenRouterClient, OpenRouterError, toSources } from '../src/openrouter';
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
    expect(models).toMatchObject([
      { id: 'openai/gpt-4o', name: 'GPT-4o', contextLength: 128000, promptPrice: 0.0000025, completionPrice: 0.00001 },
      { id: 'openrouter/auto', name: 'Auto', contextLength: 2000000, promptPrice: -1, completionPrice: -1 },
      { id: 'x/y', name: 'Y', contextLength: null, promptPrice: null, completionPrice: null },
    ]);
  });

  it('maps capability, description and date fields, with defaults when missing', async () => {
    const { fn } = fakeFetch(() => Response.json({
      data: [
        {
          id: 'a/full', name: 'Full', description: 'Does it all', created: 1792102385, context_length: 200000,
          pricing: { prompt: '0', completion: '0' },
          architecture: { input_modalities: ['text', 'image', 'file'] },
          supported_parameters: ['tools', 'reasoning', 'temperature'],
          top_provider: { max_completion_tokens: 8192 },
        },
        { id: 'a/bare', architecture: { input_modalities: 'nonsense' }, supported_parameters: null, top_provider: { max_completion_tokens: 0 } },
      ],
    }));
    const models = await createOpenRouterClient(fn).listModels();
    expect(models[0]).toEqual({
      id: 'a/full', name: 'Full', contextLength: 200000, promptPrice: 0, completionPrice: 0,
      description: 'Does it all', created: 1792102385, inputModalities: ['text', 'image', 'file'],
      supportsTools: true, supportsReasoning: true, maxOutput: 8192, cacheReadPrice: null,
    });
    expect(models[1]).toEqual({
      id: 'a/bare', name: 'a/bare', contextLength: null, promptPrice: null, completionPrice: null,
      description: '', created: null, inputModalities: ['text'],
      supportsTools: false, supportsReasoning: false, maxOutput: null, cacheReadPrice: null,
    });
  });

  it('lists a category as ordered ids and encodes marketing/seo', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ data: [{ id: 'b/two' }, { id: 'a/one' }] }));
    expect(await createOpenRouterClient(fn).listCategory('marketing/seo')).toEqual(['b/two', 'a/one']);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models?category=marketing%2Fseo');
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
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 3, cost: 0.00042, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null } },
    ]);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'openai/gpt-4o', stream: true, usage: { include: true } });
  });

  it('yields reasoning deltas separately from content', async () => {
    const { fn } = fakeFetch(() => sse(
      'data: {"choices":[{"delta":{"content":"","reasoning":"Let me think"}}]}',
      'data: {"choices":[{"delta":{"content":"Answer"}}]}',
      'data: [DONE]',
    ));
    const events = await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [] }));
    expect(events).toEqual([{ type: 'reasoning', text: 'Let me think' }, { type: 'delta', text: 'Answer' }]);
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

  it('complete() asks for usage and reports it through onUsage', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({
      choices: [{ message: { content: 'Trip ideas' } }],
      usage: { prompt_tokens: 40, completion_tokens: 6, cost: 0.0002, prompt_tokens_details: { cached_tokens: 0 } },
    }));
    const seen: unknown[] = [];
    const text = await createOpenRouterClient(fn).complete({ apiKey: 'k', model: 'm', messages: [], onUsage: (u) => seen.push(u) });
    expect(text).toBe('Trip ideas');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ usage: { include: true } });
    expect(seen).toEqual([{ promptTokens: 40, completionTokens: 6, cost: 0.0002, webSearches: null, cachedTokens: 0, cacheWriteTokens: null, reasoningTokens: null }]);
  });

  it('reads cache and reasoning token details from streamed usage', async () => {
    const { fn } = fakeFetch(() => sse(
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.01,"prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":0},"completion_tokens_details":{"reasoning_tokens":8}}}',
      'data: [DONE]',
    ));
    const events = await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [] }));
    expect(events).toEqual([{ type: 'usage', usage: {
      promptTokens: 100, completionTokens: 20, cost: 0.01, webSearches: null, cachedTokens: 60, cacheWriteTokens: 0, reasoningTokens: 8,
    } }]);
  });

  it('maps the cache read price, null when missing', async () => {
    const { fn } = fakeFetch(() => Response.json({ data: [
      { id: 'a/c', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' } },
      { id: 'a/n', pricing: { prompt: '0.000003' } },
    ] }));
    const models = await createOpenRouterClient(fn).listModels();
    expect(models.map((m) => m.cacheReadPrice)).toEqual([3e-7, null]);
  });

  it('checkKey() rejects an invalid key', async () => {
    const { fn, calls } = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(createOpenRouterClient(fn).checkKey('bad')).rejects.toBeInstanceOf(OpenRouterError);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/key');
  });
});

describe('streamChat plugins', () => {
  it('sends plugins only when given', async () => {
    const { fn, calls } = fakeFetch(() => sse('data: [DONE]'));
    const client = createOpenRouterClient(fn);
    await collect(client.streamChat({ apiKey: 'k', model: 'm', messages: [], plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }] }));
    await collect(client.streamChat({ apiKey: 'k', model: 'm', messages: [] }));
    expect(JSON.parse(String(calls[0].init.body)).plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    expect(JSON.parse(String(calls[1].init.body))).not.toHaveProperty('plugins');
  });
});

describe('streamChat web search', () => {
  const bodyOf = async (o: Partial<Parameters<ReturnType<typeof createOpenRouterClient>['streamChat']>[0]>) => {
    const { fn, calls } = fakeFetch(() => sse('data: [DONE]'));
    await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [], ...o }));
    return JSON.parse(String(calls[0].init.body));
  };

  it('adds the search tool with a 3-call cap in tool mode', async () => {
    const body = await bodyOf({ webSearch: 'tool' });
    expect(body.tools).toEqual([{ type: 'openrouter:web_search', parameters: { max_results: 5 } }]);
    expect(body.max_tool_calls).toBe(3);
    expect(body).not.toHaveProperty('plugins');
  });

  it('adds the web plugin in plugin mode, merged after the PDF parser', async () => {
    expect((await bodyOf({ webSearch: 'plugin' })).plugins).toEqual([{ id: 'web', max_results: 5 }]);
    const merged = await bodyOf({ webSearch: 'plugin', plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }] });
    expect(merged.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }, { id: 'web', max_results: 5 }]);
    expect(merged).not.toHaveProperty('tools');
  });

  it('adds nothing without web search', async () => {
    const body = await bodyOf({});
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('max_tool_calls');
    expect(body).not.toHaveProperty('plugins');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('sends a reasoning effort when one is given', async () => {
    expect((await bodyOf({ effort: 'high' })).reasoning).toEqual({ effort: 'high' });
  });

  it('turns streamed citations into sources and reads the search count', async () => {
    const annotations = [
      { type: 'url_citation', url_citation: { url: 'https://nodejs.org/en', title: 'Node.js', content: 'long text', start_index: 0, end_index: 0 } },
      { type: 'file', file: { hash: 'x' } },
      { type: 'url_citation', url_citation: { url: 'https://github.com/nodejs/node', title: 'GitHub', content: 'more' } },
    ];
    const { fn } = fakeFetch(() => sse(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi', annotations } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.015, server_tool_use_details: { web_search_requests: 2 } } })}`,
      'data: [DONE]',
    ));
    const events = await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [], webSearch: 'tool' }));
    expect(events).toContainEqual({
      type: 'sources',
      sources: [{ url: 'https://nodejs.org/en', title: 'Node.js' }, { url: 'https://github.com/nodejs/node', title: 'GitHub' }],
    });
    expect(events.at(-1)).toEqual({ type: 'usage', usage: { promptTokens: 1, completionTokens: 2, cost: 0.015, webSearches: 2, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null } });
  });

  it('reports no search count when usage lacks one', async () => {
    const { fn } = fakeFetch(() => sse(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })}`));
    const events = await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [] }));
    expect(events.at(-1)).toMatchObject({ type: 'usage', usage: { webSearches: null } });
  });
});

describe('streamChat function tools', () => {
  const passTo = { name: 'pass_to', description: 'Give the floor to the next speaker.', parameters: { type: 'object', properties: {} } };
  const bodyOf = async (o: Partial<Parameters<ReturnType<typeof createOpenRouterClient>['streamChat']>[0]>) => {
    const { fn, calls } = fakeFetch(() => sse('data: [DONE]'));
    await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [], ...o }));
    return JSON.parse(String(calls[0].init.body));
  };
  const toolChunk = (tool: object, finish?: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tool] }, finish_reason: finish ?? null }] })}`;

  it('sends function tools alongside web search', async () => {
    const body = await bodyOf({ tools: [passTo], webSearch: 'tool' });
    expect(body.tools).toEqual([
      { type: 'openrouter:web_search', parameters: { max_results: 5 } },
      { type: 'function', function: passTo },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(await bodyOf({})).not.toHaveProperty('tool_choice');
  });

  it('assembles streamed tool call arguments', async () => {
    const { fn } = fakeFetch(() => sse(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Over to you.' } }] })}`,
      toolChunk({ index: 0, id: 'c1', type: 'function', function: { name: 'pass_to', arguments: '{"na' } }),
      toolChunk({ index: 0, function: { arguments: 'me":"Egg"}' } }),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]',
    ));
    const events = await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [], tools: [passTo] }));
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toEqual([{ type: 'tool_call', name: 'pass_to', arguments: '{"name":"Egg"}' }]);
    expect(events.findIndex((e) => e.type === 'tool_call')).toBeGreaterThan(events.findIndex((e) => e.type === 'delta'));
  });

  it('emits tool calls when the stream ends without [DONE]', async () => {
    const { fn } = fakeFetch(() => sse(toolChunk({ index: 0, function: { name: 'end_discussion', arguments: '{"reason":"done"}' } })));
    const events = await collect(createOpenRouterClient(fn).streamChat({ apiKey: 'k', model: 'm', messages: [], tools: [passTo] }));
    expect(events).toEqual([{ type: 'tool_call', name: 'end_discussion', arguments: '{"reason":"done"}' }]);
  });
});

describe('toSources', () => {
  const cite = (url: string, title?: string) => ({ type: 'url_citation', url_citation: { url, title } });
  it('keeps only http(s) citations, as url and title', () => {
    expect(toSources([cite('javascript:alert(1)', 'x'), cite('data:text/html,x', 'y'), cite('/relative', 'z'), cite('http://a.example', 'A'), cite('https://b.example')]))
      .toEqual([{ url: 'http://a.example', title: 'A' }, { url: 'https://b.example', title: '' }]);
    expect(toSources('nope')).toEqual([]);
    expect(toSources(undefined)).toEqual([]);
  });
});

describe('video job client', () => {
  it('submits a job and reads its id and polling URL', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ id: 'gen-vid-1', polling_url: '/api/v1/videos/gen-vid-1', status: 'pending' }, { status: 202 }));
    const job = await createOpenRouterClient(fn).submitVideo({ apiKey: 'k', body: { model: 'm', prompt: 'p' } });
    expect(job).toEqual({ jobId: 'gen-vid-1', pollingUrl: '/api/v1/videos/gen-vid-1' });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/videos');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'm', prompt: 'p' });
  });

  it('polls relative and absolute URLs', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ status: 'completed', usage: { cost: 0.42 } }));
    const client = createOpenRouterClient(fn);
    const done = await client.getVideoJob({ apiKey: 'k', jobId: 'j', pollingUrl: '/api/v1/videos/j' });
    await client.getVideoJob({ apiKey: 'k', jobId: 'j', pollingUrl: 'https://openrouter.ai/api/v1/videos/j' });
    expect(calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/videos/j', 'https://openrouter.ai/api/v1/videos/j']);
    expect(done).toMatchObject({ status: 'completed', error: null, usage: { cost: 0.42 } });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('carries the reason a job failed', async () => {
    const { fn } = fakeFetch(() => Response.json({ status: 'failed', error: 'Content blocked' }));
    expect(await createOpenRouterClient(fn).getVideoJob({ apiKey: 'k', jobId: 'j', pollingUrl: '/api/v1/videos/j' }))
      .toEqual({ status: 'failed', error: 'Content blocked', usage: null });
  });

  it('downloads the clip with the key', async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const stream = await createOpenRouterClient(fn).downloadVideo({ apiKey: 'k', jobId: 'j' });
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/videos/j/content?index=0');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('lists video models, leaving out video-input ones', async () => {
    const { fn } = fakeFetch(() => Response.json({ data: [
      { id: 'a/vid', name: 'A', supported_durations: [5], supported_frame_images: ['first_frame'], pricing_skus: { duration_seconds: '0.1' } },
      { id: 'runway/aleph-2', name: 'Aleph' },
    ] }));
    expect((await createOpenRouterClient(fn).listVideoModels()).map((m) => m.id)).toEqual(['a/vid']);
  });
});

describe('image generation client', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

  it('posts one image request and decodes the result', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({
      data: [{ b64_json: PNG.toString('base64') }],
      usage: { prompt_tokens: 12, completion_tokens: 1290, cost: 0.039 },
    }));
    const out = await createOpenRouterClient(fn).generateImage({
      apiKey: 'k', model: 'g/banana', prompt: 'a fox', settings: { aspect: '1:1', size: '1K', quality: null, transparent: false },
      references: ['data:image/png;base64,AA'],
    });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'g/banana', prompt: 'a fox', n: 1, aspect_ratio: '1:1', resolution: '1K',
      // OpenRouter rejects bare strings here (checked with a real call); each reference is an image_url object.
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
    });
    expect(out.mime).toBe('image/png');
    expect(out.data.equals(PNG)).toBe(true);
    expect(out.usage).toMatchObject({ promptTokens: 12, completionTokens: 1290, cost: 0.039 });
  });

  it('sends quality and a transparent background only when set', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ data: [{ b64_json: PNG.toString('base64'), media_type: 'image/webp' }] }));
    const out = await createOpenRouterClient(fn).generateImage({
      apiKey: 'k', model: 'o/img', prompt: 'p', settings: { aspect: 'auto', size: null, quality: 'medium', transparent: true }, references: [],
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'o/img', prompt: 'p', n: 1, aspect_ratio: 'auto', quality: 'medium', background: 'transparent' });
    expect(out.mime).toBe('image/webp');
    expect(out.usage).toBeNull();
  });

  it('never trusts a reported type that is not a plain raster image', async () => {
    const { fn } = fakeFetch(() => Response.json({ data: [{ b64_json: PNG.toString('base64'), media_type: 'image/svg+xml' }] }));
    const out = await createOpenRouterClient(fn).generateImage({
      apiKey: 'k', model: 'm', prompt: 'p', settings: { aspect: '1:1', size: null, quality: null, transparent: false }, references: [],
    });
    expect(out.mime).toBe('image/png');
  });

  it('turns a failed generation into an OpenRouterError', async () => {
    const { fn } = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 502 }));
    const err = await createOpenRouterClient(fn)
      .generateImage({ apiKey: 'k', model: 'm', prompt: 'p', settings: { aspect: '1:1', size: null, quality: null, transparent: false }, references: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.status).toBe(502);
  });

  it('rejects a response with no image', async () => {
    const { fn } = fakeFetch(() => Response.json({ data: [] }));
    await expect(createOpenRouterClient(fn)
      .generateImage({ apiKey: 'k', model: 'm', prompt: 'p', settings: { aspect: '1:1', size: null, quality: null, transparent: false }, references: [] }))
      .rejects.toThrow(OpenRouterError);
  });

  it('lists image models with their pricing, skipping SVG-only ones', async () => {
    const { fn, calls } = fakeFetch(({ url }) => {
      if (url.endsWith('/images/models')) {
        return Response.json({ data: [
          { id: 'a/img', name: 'A', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1'] } } },
          { id: 'r/vec', name: 'Vec', supported_parameters: { output_format: { type: 'enum', values: ['svg'] } } },
          { id: 'b/img', name: 'B', supported_parameters: {} },
        ] });
      }
      if (url.includes('/a/img/')) return Response.json({ endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] });
      if (url.includes('/b/img/')) return new Response('nope', { status: 500 });
      return Response.json({ endpoints: [{ pricing: [] }] });
    });
    const models = await createOpenRouterClient(fn).listImageModels();
    expect(models.map((m) => [m.id, m.price.kind])).toEqual([['a/img', 'image'], ['b/img', 'unknown']]);
    expect(calls.some((c) => c.url.endsWith('/images/models/a/img/endpoints'))).toBe(true);
  });
});
