import { describe, expect, it } from 'vitest';
import type { StreamEvent, Usage } from '../src/openrouter';
import type { ChatMessage } from '../src/prompt';
import { formatResults, withLocalSearch } from '../src/providers/localSearch';
import { ProviderError, type ChatRequest } from '../src/providers/types';
import { SearchError, type SearchResult, type SearchService } from '../src/webSearch/types';

const RESULTS: SearchResult[] = [
  { title: 'Cats', url: 'https://cats.example/a', text: 'About cats.' },
  { title: 'More cats', url: 'https://cats.example/b', text: 'Even more.' },
];

const usage = (o: Partial<Usage> = {}): Usage => ({
  promptTokens: null, completionTokens: null, cost: null, webSearches: null, cachedTokens: null,
  cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null, ...o,
});

function stub(impl?: (q: string) => Promise<SearchResult[]>) {
  const queries: string[] = [];
  const service: SearchService = {
    name: 'SearXNG',
    async search(q) { queries.push(q); return impl ? impl(q) : RESULTS; },
    async test() {},
  };
  return { service, queries };
}

/** A scripted model: each call to run takes the next round's events. */
function scripted(rounds: StreamEvent[][]) {
  const requests: ChatRequest[] = [];
  const run = async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
    requests.push(req);
    const round = rounds[Math.min(requests.length - 1, rounds.length - 1)];
    for (const e of round) yield e;
  };
  return { run, requests };
}

const call = (args: string, name = 'web_search'): StreamEvent => ({ type: 'tool_call', name, arguments: args });
const delta = (text: string): StreamEvent => ({ type: 'delta', text });
const base = (text = 'hi'): ChatRequest & { webSearch: 'tool' } => ({
  model: 'm', webSearch: 'tool', messages: [{ role: 'user', content: text }],
});
async function collect(g: AsyncGenerator<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}
const usageOf = (events: StreamEvent[]) => events.filter((e) => e.type === 'usage').map((e) => (e as { usage: Usage }).usage);
const lastOf = (r: ChatRequest) => r.messages[r.messages.length - 1];

describe('withLocalSearch tool mode', () => {
  it('searches, feeds the results back, and answers', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([
      [call('{"query":"cats"}'), { type: 'usage', usage: usage({ promptTokens: 10 }) }],
      [delta('Cats are '), delta('great.'), { type: 'usage', usage: usage({ promptTokens: 30 }) }],
    ]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(queries).toEqual(['cats']);
    expect(events.map((e) => e.type)).toEqual(['sources', 'delta', 'delta', 'usage']);
    expect(events[0]).toEqual({ type: 'sources', sources: [{ url: 'https://cats.example/a', title: 'Cats' }, { url: 'https://cats.example/b', title: 'More cats' }] });
    const second = requests[1].messages;
    expect(second[1].role).toBe('assistant');
    expect(second[1].content).toBe('');
    expect(second[1].toolCalls).toEqual([{ id: 'call_1', name: 'web_search', arguments: '{"query":"cats"}' }]);
    expect(second[2]).toEqual({ role: 'tool', content: formatResults(RESULTS), toolCallId: 'call_1', toolName: 'web_search' });
    expect(requests[0].tools?.[0].name).toBe('web_search');
    expect(requests[0].webSearch).toBeUndefined();
    const u = usageOf(events)[0];
    expect(u.webSearches).toBe(1);
    expect(u.cost).toBe(0);
    expect(u.cachedTokens).toBeNull();
  });

  it('caps a model that always searches at 3 searches and 4 rounds', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([[call('{"query":"again"}')]]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(queries).toHaveLength(3);
    expect(requests).toHaveLength(4);
    expect(requests[3].tools).toBeUndefined();
    expect(usageOf(events)[0].webSearches).toBe(3);
  });

  it('refuses searches over the cap within one round', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([
      [call('{"query":"a"}'), call('{"query":"b"}'), call('{"query":"c"}'), call('{"query":"d"}')],
      [delta('ok')],
    ]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(queries).toEqual(['a', 'b', 'c']);
    expect(lastOf(requests[1]).content).toBe('Search limit reached. Answer with what you have.');
    expect(requests[1].tools).toBeUndefined();
    expect(usageOf(events)[0].webSearches).toBe(3);
  });

  it('counts two calls in one round as two searches', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([[call('{"query":"a"}'), call('{"query":"b"}')], [delta('done')]]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(queries).toEqual(['a', 'b']);
    expect(requests[1].messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_1', 'call_2']);
    expect(usageOf(events)[0].webSearches).toBe(2);
  });

  it('ends after 4 rounds when the model keeps calling with no query', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([[call('{}')]]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(queries).toHaveLength(0);
    expect(requests).toHaveLength(4);
    expect(requests[3].tools).toBeUndefined();
    expect(lastOf(requests[1]).content).toBe('The search needs a "query" string.');
    expect(usageOf(events)[0].webSearches).toBe(0);
  });

  it('treats unparseable arguments as a bad query and unknown names as unknown', async () => {
    const { service } = stub();
    const { run, requests } = scripted([[call('not json'), call('{"query":"x"}', 'lookup')], [delta('ok')]]);
    await collect(withLocalSearch(run, base(), service));
    const tools = requests[1].messages.filter((m) => m.role === 'tool');
    expect(tools[0].content).toBe('The search needs a "query" string.');
    expect(tools[1].content).toBe('There is no tool called lookup.');
    expect(tools[1].toolName).toBe('lookup');
  });

  it('gives the model a failed search as a tool result and still answers', async () => {
    const { service } = stub(async () => { throw new SearchError("Can't reach SearXNG at localhost:8080. Is it running?"); });
    const { run, requests } = scripted([[call('{"query":"cats"}')], [delta('Sorry.')]]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(lastOf(requests[1]).content).toBe("Search failed: Can't reach SearXNG at localhost:8080. Is it running?");
    expect(events.map((e) => e.type)).toEqual(['delta', 'usage']);
    expect(usageOf(events)[0].webSearches).toBe(1);
  });

  it('rethrows an aborted search', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { service } = stub(async () => { throw abort; });
    const { run } = scripted([[call('{"query":"cats"}')]]);
    await expect(collect(withLocalSearch(run, base(), service))).rejects.toBe(abort);
  });

  it('passes the signal to searches and reports empty results', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const service: SearchService = { name: 'Tavily', async search(_q, s) { seen.push(s); return []; }, async test() {} };
    const ctl = new AbortController();
    const { run, requests } = scripted([[call('{"query":"x"}')], [delta('ok')]]);
    await collect(withLocalSearch(run, { ...base(), signal: ctl.signal }, service));
    expect(seen).toEqual([ctl.signal]);
    expect(lastOf(requests[1]).content).toBe('No results.');
  });

  it('passes text through, keeps the round text on the assistant message, and merges usage', async () => {
    const { service } = stub();
    const { run, requests } = scripted([
      [{ type: 'status', status: 'loading' }, { type: 'reasoning', text: 'hm' }, delta('Let me check. '), call('{"query":"q"}'),
        { type: 'usage', usage: usage({ promptTokens: 100, completionTokens: 20, generationMs: 200, loadMs: 900, reasoningTokens: 5 }) }],
      [delta('Answer'), { type: 'usage', usage: usage({ promptTokens: 300, completionTokens: 50, generationMs: 500, loadMs: 10 }) }],
    ]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(events.map((e) => e.type)).toEqual(['status', 'reasoning', 'delta', 'sources', 'delta', 'usage']);
    expect(requests[1].messages[1].content).toBe('Let me check. ');
    expect(usageOf(events)[0]).toEqual(usage({
      promptTokens: 300, completionTokens: 70, generationMs: 700, loadMs: 900, reasoningTokens: 5, cost: 0, webSearches: 1,
    }));
  });

  it('reports null for fields no round reported', async () => {
    const { service } = stub();
    const { run } = scripted([[delta('hi')]]);
    const events = await collect(withLocalSearch(run, base(), service));
    expect(usageOf(events)[0]).toEqual(usage({ cost: 0, webSearches: 0 }));
  });
});

describe('withLocalSearch plugin mode', () => {
  const plugin = (content: ChatMessage['content']): ChatRequest & { webSearch: 'plugin' } => ({
    model: 'm', webSearch: 'plugin', messages: [{ role: 'system', content: 's' }, { role: 'user', content }],
  });

  it('searches the message, appends the results block, and sends no tools', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([[delta('Node 24 is out.'), { type: 'usage', usage: usage({ promptTokens: 50, completionTokens: 9 }) }]]);
    const events = await collect(withLocalSearch(run, plugin("What's new in Node 24?"), service));
    expect(queries).toEqual(["What's new in Node 24?"]);
    expect(events.map((e) => e.type)).toEqual(['sources', 'delta', 'usage']);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].webSearch).toBeUndefined();
    const last = requests[0].messages[1].content as { type: string; text: string }[];
    expect(last[last.length - 1].text).toBe(
      `<search_results query="What's new in Node 24?">\n${formatResults(RESULTS)}\n</search_results>\nUse these web search results if they help, and mention the sources you use.`,
    );
    expect(usageOf(events)[0]).toEqual(usage({ promptTokens: 50, completionTokens: 9, webSearches: 1 }));
  });

  it('cuts a long message to 400 characters for the query', async () => {
    const { service, queries } = stub();
    const { run } = scripted([[delta('x')]]);
    await collect(withLocalSearch(run, plugin('a'.repeat(1000)), service));
    expect(queries[0]).toBe('a'.repeat(400));
  });

  it('joins text parts of a multi-part message', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([[delta('x')]]);
    await collect(withLocalSearch(run, plugin([
      { type: 'text', text: 'first' }, { type: 'image_url', image_url: { url: 'data:x' } }, { type: 'text', text: 'second' },
    ]), service));
    expect(queries[0]).toBe('first\nsecond');
    const parts = requests[0].messages[1].content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'text']);
  });

  it('throws a ProviderError before calling the model when the search fails', async () => {
    const { service } = stub(async () => { throw new SearchError("SearXNG didn't answer within 10 seconds."); });
    const { run, requests } = scripted([[delta('x')]]);
    const err = await collect(withLocalSearch(run, plugin('hello'), service)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("Web search failed: SearXNG didn't answer within 10 seconds.");
    expect(err.status).toBe(502);
    expect(requests).toHaveLength(0);
  });

  it('streams without searching when the message has no text', async () => {
    const { service, queries } = stub();
    const { run, requests } = scripted([[delta('A picture.')]]);
    const req = plugin([{ type: 'image_url', image_url: { url: 'data:x' } }]);
    const events = await collect(withLocalSearch(run, req, service));
    expect(queries).toHaveLength(0);
    expect(requests[0].messages).toBe(req.messages);
    expect(requests[0].tools).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['delta']);
  });

  it('rethrows an abort', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { service } = stub(async () => { throw abort; });
    const { run } = scripted([[delta('x')]]);
    await expect(collect(withLocalSearch(run, plugin('hello'), service))).rejects.toBe(abort);
  });
});
