import type { StreamEvent, Usage } from '../openrouter';
import type { ChatMessage } from '../prompt';
import { guardBody, localFetch, readListing } from './localHttp';
import { readChatStream } from './openaiStream';
import { LocalServerError, type ChatRequest, type CompleteRequest, type LocalClient, type LocalModelInfo } from './types';

export const LIST_TIMEOUT_MS = 1_500;

type Server = { name: string; baseUrl: string };

/** Messages without OpenRouter-only parts: cache markers are dropped, and PDF `file` parts (unsupported locally) are left out. */
function toLocalMessages(messages: ChatMessage[]): object[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : '' };
    if (m.toolCalls?.length) {
      const tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      return { role: m.role, content: typeof m.content === 'string' ? m.content : '', tool_calls };
    }
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const parts = m.content.flatMap((p): object[] =>
      p.type === 'text' ? [{ type: 'text', text: p.text }] : p.type === 'image_url' ? [{ type: 'image_url', image_url: { url: p.image_url.url } }] : [],
    );
    return { role: m.role, content: parts };
  });
}

function usageOf(raw: any, loadMs: number | null = null): Usage {
  const reasoning = raw?.completion_tokens_details?.reasoning_tokens;
  return {
    promptTokens: typeof raw?.prompt_tokens === 'number' ? raw.prompt_tokens : null,
    completionTokens: typeof raw?.completion_tokens === 'number' ? raw.completion_tokens : null,
    cost: 0,
    webSearches: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: typeof reasoning === 'number' ? reasoning : null,
    loadMs,
    generationMs: null,
  };
}

/**
 * Chat over `/v1/chat/completions`, shared by LM Studio and generic OpenAI-compatible servers.
 * `prepare` runs before each request (LM Studio loads the model there) and returns the milliseconds the load took, if it loaded.
 */
export function createOpenAIChat(
  server: Server,
  fetchImpl: typeof fetch,
  prepare?: (o: { model: string; contextWindow?: number; signal?: AbortSignal }) => Promise<number | null>,
): Pick<LocalClient, 'streamChat' | 'complete'> {
  const failure = (detail: string) => new LocalServerError(`${server.name} couldn't run this model: ${detail}`, 500);

  async function* stream(o: ChatRequest & { contextWindow?: number; maxTokens?: number }): AsyncGenerator<StreamEvent> {
    const loadMs = (await prepare?.(o)) ?? null;
    const res = await localFetch(
      server,
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: o.signal,
        body: JSON.stringify({
          model: o.model,
          messages: toLocalMessages(o.messages),
          stream: true,
          stream_options: { include_usage: true },
          ...(o.maxTokens !== undefined ? { max_tokens: o.maxTokens } : {}),
          ...(o.tools?.length ? { tools: o.tools.map((f) => ({ type: 'function', function: f })), tool_choice: 'auto' } : {}),
        }),
      },
      fetchImpl,
    );
    if (!res.body) throw failure('empty response');
    yield* readChatStream(
      guardBody(res.body, server, o.signal),
      (_status, message) => {
        throw failure(typeof message === 'string' && message ? message : 'unknown error');
      },
      (raw) => usageOf(raw, loadMs),
    );
  }

  return {
    streamChat: (o) => stream(o),
    async complete(o: CompleteRequest & { contextWindow?: number }) {
      let text = '';
      for await (const e of stream(o)) {
        if (e.type === 'delta') text += e.text;
        else if (e.type === 'usage') o.onUsage?.(e.usage);
      }
      return text;
    },
  };
}

/** A server that speaks only the OpenAI API: models are listed without capabilities, and chats run as they are. */
export function createOpenAICompatClient(server: Server, fetchImpl: typeof fetch = fetch): LocalClient {
  return {
    async listModels() {
      const body: any = await readListing(await localFetch(server, '/v1/models', { timeoutMs: LIST_TIMEOUT_MS }, fetchImpl), server);
      return (body.data ?? []).map(
        (m: any): LocalModelInfo => ({
          name: String(m.id),
          sizeBytes: null,
          contextLength: null,
          inputModalities: ['text'],
          supportsTools: false,
          supportsReasoning: false,
          capsKnown: false,
        }),
      );
    },
    // The OpenAI API has no way to ask whether a model is in memory.
    loadState: async () => null,
    ...createOpenAIChat(server, fetchImpl),
  };
}
