import type { FunctionTool, StreamEvent, Usage, WebSearchMode } from '../openrouter';
import type { ChatMessage, ContentPart, ToolCall } from '../prompt';
import { isAbort, type SearchResult, type SearchService } from '../webSearch/types';
import { ProviderError, type ChatRequest } from './types';

const MAX_SEARCHES = 3;
const MAX_ROUNDS = 4;
const MAX_QUERY = 400;

export const WEB_SEARCH_TOOL: FunctionTool = {
  name: 'web_search',
  description: 'Search the web. Use it for recent events or facts you are not sure of. Returns the top results with their addresses.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to search for' } },
    required: ['query'],
  },
};

/** Results as text, one block per result; used for tool results and the search-before-reply block. */
export function formatResults(results: SearchResult[]): string {
  if (!results.length) return 'No results.';
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.text}`).join('\n\n');
}

const toSources = (results: SearchResult[]): StreamEvent => ({
  type: 'sources',
  sources: results.map((r) => ({ url: r.url, title: r.title })),
});

const messageText = (m: ChatMessage): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n');

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Run = (req: ChatRequest) => AsyncGenerator<StreamEvent>;

/** Runs web search for a local model: a web_search tool loop ('tool') or one search before the reply ('plugin'). */
export async function* withLocalSearch(
  run: Run,
  req: ChatRequest & { webSearch: WebSearchMode },
  service: SearchService,
): AsyncGenerator<StreamEvent> {
  const { webSearch, tools: _tools, ...rest } = req;
  if (webSearch === 'plugin') yield* searchFirst(run, rest, service);
  else yield* searchLoop(run, rest, service);
}

async function* searchFirst(run: Run, req: ChatRequest, service: SearchService): AsyncGenerator<StreamEvent> {
  let index = -1;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === 'user') { index = i; break; }
  }
  const query = index < 0 ? '' : messageText(req.messages[index]).trim().slice(0, MAX_QUERY);
  if (!query) {
    yield* run(req);
    return;
  }
  let results: SearchResult[];
  try {
    results = await service.search(query, req.signal);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ProviderError(`Web search failed: ${errorText(e)}`, 502);
  }
  yield toSources(results);
  const block = `<search_results query="${query}">\n${formatResults(results)}\n</search_results>\nUse these web search results if they help, and mention the sources you use.`;
  const message = req.messages[index];
  const parts: ContentPart[] = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : [...message.content];
  parts.push({ type: 'text', text: block });
  const messages = req.messages.slice();
  messages[index] = { ...message, content: parts };
  for await (const e of run({ ...req, messages })) {
    yield e.type === 'usage' ? { type: 'usage', usage: { ...e.usage, webSearches: 1 } } : e;
  }
}

const sum = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

async function* searchLoop(run: Run, req: ChatRequest, service: SearchService): AsyncGenerator<StreamEvent> {
  const messages = req.messages.slice();
  let searches = 0;
  let calls = 0;
  const total: Usage = {
    promptTokens: null, completionTokens: null, cost: 0, webSearches: 0, cachedTokens: null,
    cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null,
  };

  let wroteText = false;
  const snapshot = (): StreamEvent => ({ type: 'usage', usage: { ...total, webSearches: searches } });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const withTools = round < MAX_ROUNDS - 1 && searches < MAX_SEARCHES;
    const roundReq: ChatRequest = { ...req, messages: messages.slice() };
    if (withTools) roundReq.tools = [WEB_SEARCH_TOOL];
    let text = '';
    let roundHasText = false;
    const pending: { name: string; arguments: string }[] = [];
    for await (const e of run(roundReq)) {
      if (e.type === 'tool_call') pending.push({ name: e.name, arguments: e.arguments });
      else if (e.type === 'usage') {
        const u = e.usage;
        if (u.promptTokens !== null) total.promptTokens = u.promptTokens;
        total.completionTokens = sum(total.completionTokens, u.completionTokens);
        total.reasoningTokens = sum(total.reasoningTokens, u.reasoningTokens);
        total.generationMs = sum(total.generationMs, u.generationMs);
        if (round === 0) total.loadMs = u.loadMs;
      } else {
        if (e.type === 'delta') {
          if (!roundHasText && wroteText) yield { type: 'delta', text: '\n\n' };
          roundHasText = true;
          wroteText = true;
          text += e.text;
        }
        yield e;
      }
    }
    if (!withTools || !pending.length) break;

    const toolCalls: ToolCall[] = pending.map((p) => ({ id: `call_${++calls}`, name: p.name, arguments: p.arguments }));
    messages.push({ role: 'assistant', content: text, toolCalls });
    for (const tc of toolCalls) {
      let content: string;
      if (tc.name !== WEB_SEARCH_TOOL.name) content = `There is no tool called ${tc.name}.`;
      else {
        const query = parseQuery(tc.arguments);
        if (!query) content = 'The search needs a "query" string.';
        else if (searches >= MAX_SEARCHES) content = 'Search limit reached. Answer with what you have.';
        else {
          searches++;
          try {
            const results = await service.search(query, req.signal);
            if (results.length) yield toSources(results);
            content = formatResults(results);
          } catch (e) {
            if (isAbort(e)) throw e;
            content = `Search failed: ${errorText(e)}`;
          }
        }
      }
      messages.push({ role: 'tool', content, toolCallId: tc.id, toolName: tc.name });
    }
    if (searches > 0) yield snapshot();
  }
  yield snapshot();
}

function parseQuery(args: string): string {
  try {
    const q = (JSON.parse(args) as { query?: unknown } | null)?.query;
    return typeof q === 'string' ? q.trim().slice(0, MAX_QUERY) : '';
  } catch {
    return '';
  }
}
