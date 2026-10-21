import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startFakeSearchServer, type FakeSearch } from '../../test/fakeSearchServer';
import { createSearxng } from '../src/webSearch/searxng';
import { createTavily } from '../src/webSearch/tavily';
import { SearchError } from '../src/webSearch/types';

const JSON_OFF =
  'SearXNG answered, but its JSON output is turned off. In SearXNG\'s settings.yml, under "search:", add json to "formats" so it reads "formats: [html, json]", then restart SearXNG.';

let fake: FakeSearch;
beforeEach(async () => {
  fake = await startFakeSearchServer();
});
afterEach(async () => {
  await fake.close();
});

const item = (n: number, content = `text ${n}`) => ({ title: `t${n}`, url: `https://example.com/${n}`, content });

describe('SearXNG', () => {
  it('returns the results with content as text and asks for json', async () => {
    const results = await createSearxng(fake.url).search('cats');
    expect(results).toEqual([
      { title: 'Cats - Wikipedia', url: 'https://en.wikipedia.org/wiki/Cat', text: 'The cat is a small domesticated carnivorous mammal.' },
      { title: 'Cat care guide', url: 'https://example.com/cat-care', text: 'How to look after a cat.' },
      { title: 'Cat facts', url: 'https://example.org/facts', text: 'Cats sleep for most of the day.' },
    ]);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/search', query: { q: 'cats', format: 'json' } });
  });

  it('keeps at most 5 results', async () => {
    fake.setResults([1, 2, 3, 4, 5, 6, 7].map((n) => item(n)));
    expect(await createSearxng(fake.url).search('x')).toHaveLength(5);
  });

  it('cuts long text to 800 characters ending with an ellipsis', async () => {
    fake.setResults([item(1, 'a'.repeat(2000))]);
    const [r] = await createSearxng(fake.url).search('x');
    expect(r.text).toHaveLength(800);
    expect(r.text.endsWith('…')).toBe(true);
  });

  it('drops results without an http(s) url and blanks a missing title', async () => {
    fake.setResults([
      { title: 'bad', url: 'javascript:alert(1)', content: 'x' },
      { title: undefined as any, url: 'http://ok.example/', content: 'y' },
    ]);
    expect(await createSearxng(fake.url).search('x')).toEqual([{ title: '', url: 'http://ok.example/', text: 'y' }]);
  });

  it('explains when JSON output is off, for search and test', async () => {
    fake.setJson(false);
    const s = createSearxng(fake.url);
    await expect(s.search('x')).rejects.toThrow(JSON_OFF);
    await expect(s.test()).rejects.toThrow(JSON_OFF);
    await expect(s.search('x')).rejects.toBeInstanceOf(SearchError);
  });

  it('test() searches for openchat', async () => {
    await createSearxng(fake.url).test();
    expect(fake.requests[0].query.q).toBe('openchat');
  });

  it('says so when the server is not running', async () => {
    const url = fake.url;
    await fake.close();
    await expect(createSearxng(url).search('x')).rejects.toThrow(`Can't reach SearXNG at ${url.replace('http://', '')}. Is it running?`);
    fake = await startFakeSearchServer();
  });

  it('reports other failures with the status', async () => {
    fake.failNext(500);
    await expect(createSearxng(fake.url).search('x')).rejects.toThrow("SearXNG couldn't search (HTTP 500).");
  });

  it('times out', async () => {
    fake.hang(true);
    await expect(createSearxng(fake.url, fetch, { timeoutMs: 200 }).search('x')).rejects.toThrow("SearXNG didn't answer within 10 seconds.");
  });

  it('passes the caller abort through', async () => {
    fake.hang(true);
    const ac = new AbortController();
    const p = createSearxng(fake.url).search('x', ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Tavily', () => {
  it('sends the bearer key and max_results 5, and maps the results', async () => {
    const results = await createTavily('tvly-test', fake.url).search('cats');
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ title: 'Cats - Wikipedia', url: 'https://en.wikipedia.org/wiki/Cat', text: 'The cat is a small domesticated carnivorous mammal.' });
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      path: '/search',
      auth: 'Bearer tvly-test',
      body: { query: 'cats', max_results: 5, search_depth: 'basic' },
    });
  });

  it("rejects a wrong key", async () => {
    await expect(createTavily('nope', fake.url).search('x')).rejects.toThrow("Tavily didn't accept this API key.");
  });

  it.each([
    [429, 'Tavily is limiting searches right now. Try again in a minute.'],
    [432, "Your Tavily plan's search limit is used up."],
    [500, "Tavily couldn't search (HTTP 500)."],
  ])('maps HTTP %i', async (status, copy) => {
    fake.failNext(status);
    await expect(createTavily('tvly-test', fake.url).search('x')).rejects.toThrow(copy);
  });

  it('test() uses /usage and not /search', async () => {
    await createTavily('tvly-test', fake.url).test();
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /usage']);
    await expect(createTavily('bad', fake.url).test()).rejects.toThrow("Tavily didn't accept this API key.");
  });

  it('says so when it cannot connect', async () => {
    const url = fake.url;
    await fake.close();
    await expect(createTavily('tvly-test', url).search('x')).rejects.toThrow("Can't reach Tavily. Check your internet connection.");
    fake = await startFakeSearchServer();
  });

  it('times out', async () => {
    fake.hang(true);
    await expect(createTavily('tvly-test', fake.url, fetch, { timeoutMs: 200 }).search('x')).rejects.toThrow("Tavily didn't answer within 10 seconds.");
  });
});
