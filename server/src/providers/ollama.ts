import type { StreamEvent, Usage } from '../openrouter';
import type { ChatMessage } from '../prompt';
import { localFetch } from './localHttp';
import { LocalServerError, type ChatRequest, type CompleteRequest, type LocalClient, type LocalModelInfo } from './types';

const LIST_TIMEOUT_MS = 1_500;
const SHOW_CONCURRENCY = 4;

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
}

/** OpenAI-shaped messages to Ollama's: text parts joined, image data URLs moved to `images`, everything else dropped. */
function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const texts: string[] = [];
    const images: string[] = [];
    for (const part of m.content) {
      if (part.type === 'text') texts.push(part.text);
      else if (part.type === 'image_url') {
        const comma = part.image_url.url.startsWith('data:') ? part.image_url.url.indexOf(',') : -1;
        if (comma >= 0) images.push(part.image_url.url.slice(comma + 1));
      }
    }
    return { role: m.role, content: texts.join('\n'), ...(images.length ? { images } : {}) };
  });
}

function usageOf(line: any): Usage {
  return {
    promptTokens: typeof line.prompt_eval_count === 'number' ? line.prompt_eval_count : null,
    completionTokens: typeof line.eval_count === 'number' ? line.eval_count : null,
    cost: 0,
    webSearches: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
}

export function createOllamaClient(server: { name: string; baseUrl: string }, fetchImpl: typeof fetch = fetch): LocalClient {
  const post = (path: string, body: unknown, signal?: AbortSignal, timeoutMs?: number) =>
    localFetch(
      server,
      path,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, timeoutMs },
      fetchImpl,
    );
  const failure = (detail: unknown) => new LocalServerError(`${server.name} couldn't run this model: ${String(detail)}`, 500);

  function chatBody(o: ChatRequest & { contextWindow?: number; maxTokens?: number }, stream: boolean) {
    const options: Record<string, number> = {};
    if (o.contextWindow !== undefined) options.num_ctx = o.contextWindow;
    if (o.maxTokens !== undefined) options.num_predict = o.maxTokens;
    return {
      model: o.model,
      messages: toOllamaMessages(o.messages),
      stream,
      options,
      ...(o.think !== undefined ? { think: o.think } : {}),
      ...(o.tools?.length ? { tools: o.tools.map((f) => ({ type: 'function', function: f })) } : {}),
    };
  }

  const toolCallEvent = (call: any): StreamEvent => ({
    type: 'tool_call',
    name: String(call?.function?.name ?? ''),
    arguments: JSON.stringify(call?.function?.arguments ?? {}),
  });

  async function describe(name: string, sizeBytes: number | null): Promise<LocalModelInfo> {
    try {
      const show: any = await (await post('/api/show', { model: name }, undefined, LIST_TIMEOUT_MS)).json();
      const caps: string[] = Array.isArray(show.capabilities) ? show.capabilities : [];
      const key = Object.keys(show.model_info ?? {}).find((k) => k.endsWith('.context_length'));
      const ctx = key ? show.model_info[key] : null;
      return {
        name,
        sizeBytes,
        contextLength: typeof ctx === 'number' ? ctx : null,
        inputModalities: caps.includes('vision') ? ['text', 'image'] : ['text'],
        supportsTools: caps.includes('tools'),
        supportsReasoning: caps.includes('thinking'),
        capsKnown: true,
      };
    } catch {
      // One model that won't describe itself should not hide the rest; an unreachable server already failed on /api/tags.
      return { name, sizeBytes, contextLength: null, inputModalities: ['text'], supportsTools: false, supportsReasoning: false, capsKnown: false };
    }
  }

  return {
    async listModels() {
      const tags: any = await (await localFetch(server, '/api/tags', { timeoutMs: LIST_TIMEOUT_MS }, fetchImpl)).json();
      const entries: { name: string; size: number | null }[] = (tags.models ?? []).map((m: any) => ({
        name: m.name ?? m.model,
        size: typeof m.size === 'number' ? m.size : null,
      }));
      const out: LocalModelInfo[] = new Array(entries.length);
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const i = next++;
          out[i] = await describe(entries[i].name, entries[i].size);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, entries.length) }, worker));
      return out;
    },

    async *streamChat(o) {
      const res = await post('/api/chat', chatBody(o, true), o.signal);
      const decoder = new TextDecoder();
      const calls: StreamEvent[] = [];
      let buffer = '';
      const handle = function* (raw: string): Generator<StreamEvent> {
        if (!raw.trim()) return;
        let line: any;
        try {
          line = JSON.parse(raw);
        } catch {
          return;
        }
        if (line.error) throw failure(line.error);
        if (line.message?.thinking) yield { type: 'reasoning', text: line.message.thinking };
        if (line.message?.content) yield { type: 'delta', text: line.message.content };
        for (const call of line.message?.tool_calls ?? []) calls.push(toolCallEvent(call));
        if (line.done) yield { type: 'usage', usage: usageOf(line) };
      };
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          yield* handle(raw);
        }
      }
      yield* handle(buffer + decoder.decode());
      yield* calls;
    },

    async complete(o: CompleteRequest & { contextWindow?: number }) {
      const res = await post('/api/chat', chatBody(o, false));
      const body: any = await res.json();
      if (body.error) throw failure(body.error);
      if (body.done) o.onUsage?.(usageOf(body));
      return String(body.message?.content ?? '');
    },
  };
}
