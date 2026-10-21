import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLocalServer, type FakeServer } from './fakeLocalServer';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('fake local server: ollama', () => {
  it('lists models, streams NDJSON chat and records requests', async () => {
    server = await startFakeLocalServer({ flavor: 'ollama', models: [{ name: 'qwen3:1.7b', tools: true }] });
    const tags = await (await fetch(`${server.url}/api/tags`)).json();
    expect(tags.models.map((m: any) => m.name)).toEqual(['qwen3:1.7b']);

    server.reply({ text: ['Hel', 'lo'], promptTokens: 7, completionTokens: 2 });
    const body = { model: 'qwen3:1.7b', messages: [{ role: 'user', content: 'hi' }] };
    const res = await post(`${server.url}/api/chat`, body);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.slice(0, -1).map((l) => l.message.content).join('')).toBe('Hello');
    const last = lines[lines.length - 1];
    expect(last.done).toBe(true);
    expect(last.prompt_eval_count).toBe(7);
    expect(last.eval_count).toBe(2);
    expect(server.requests.find((r) => r.path === '/api/chat')?.body).toEqual(body);
  });

  it('shows capabilities, 404s unknown models and fails on demand', async () => {
    server = await startFakeLocalServer({ flavor: 'ollama', models: [{ name: 'a', tools: true, contextLength: 1234 }] });
    const show = await (await post(`${server.url}/api/show`, { model: 'a' })).json();
    expect(show.capabilities).toEqual(['completion', 'tools']);
    expect(show.model_info['fake.context_length']).toBe(1234);
    const missing = await post(`${server.url}/api/show`, { model: 'nope' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("model 'nope' not found");

    server.failNext(500, 'boom');
    const failed = await post(`${server.url}/api/chat`, { model: 'a' });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'boom' });
  });
});

describe('fake local server: ollama details', () => {
  it('answers stream:false with one object and queues replies in order', async () => {
    server = await startFakeLocalServer({ flavor: 'ollama', models: [{ name: 'a' }] });
    server.reply({ text: ['one'] });
    server.reply({ text: ['two ', 'parts'], thinking: ['hm'], promptTokens: 5, completionTokens: 3 });
    const chat = (stream: boolean) => post(`${server!.url}/api/chat`, { model: 'a', stream });
    const first = (await (await chat(false)).json()) as any;
    expect(first.message.content).toBe('one');
    const second = (await (await chat(false)).json()) as any;
    expect(second).toMatchObject({ done: true, prompt_eval_count: 5, eval_count: 3, message: { content: 'two parts', thinking: 'hm' } });
    const third = (await (await chat(false)).json()) as any;
    expect(third.message.content).toBe('two parts');
  });
});

describe('fake local server: lmstudio', () => {
  it('streams SSE chat ending in [DONE] with usage', async () => {
    server = await startFakeLocalServer({ flavor: 'lmstudio', models: [{ name: 'm' }] });
    server.reply({ text: ['Hel', 'lo'], promptTokens: 3, completionTokens: 2 });
    const res = await post(`${server.url}/v1/chat/completions`, { model: 'm', stream: true });
    const events = (await res.text()).split('\n\n').map((e) => e.trim()).filter(Boolean);
    expect(events[events.length - 1]).toBe('data: [DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.replace(/^data: /, '')));
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hello');
    expect(chunks[chunks.length - 1].usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it('load changes the reported loaded window', async () => {
    server = await startFakeLocalServer({ flavor: 'lmstudio', models: [{ name: 'm', contextLength: 8192, tools: true }] });
    const before = await (await fetch(`${server.url}/api/v1/models`)).json();
    expect(before.models[0].max_context_length).toBe(8192);
    expect(before.models[0].loaded_instances).toEqual([]);
    expect(before.models[0].capabilities).toEqual({ vision: false, trained_for_tool_use: true });
    await post(`${server.url}/api/v1/models/load`, { model: 'm', context_length: 4096 });
    const after = await (await fetch(`${server.url}/api/v1/models`)).json();
    expect(after.models[0].loaded_instances[0].config.context_length).toBe(4096);
    const v1 = await (await fetch(`${server.url}/v1/models`)).json();
    expect(v1.data[0].id).toBe('m');
  });
});

describe('fake local server: openai', () => {
  it('lists /v1/models and reports errors in OpenAI format', async () => {
    server = await startFakeLocalServer({ flavor: 'openai', models: [{ name: 'x' }] });
    expect((await (await fetch(`${server.url}/v1/models`)).json()).data).toEqual([expect.objectContaining({ id: 'x' })]);
    server.failNext(401, 'bad key');
    const res = await post(`${server.url}/v1/chat/completions`, { model: 'x' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe('bad key');
  });
});
