import { parseSSE } from '../../shared/sse';
import type { CatalogModel } from '../../shared/types';
import type { ChatMessage } from './prompt';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'OpenRouter rejected the API key. Check it in Settings.',
  402: 'Your OpenRouter account is out of credits.',
  404: 'That model is not available on OpenRouter.',
  408: 'The request to OpenRouter timed out.',
  429: 'Rate limited by OpenRouter or the model provider. Wait a moment and retry.',
  502: 'The model provider returned an error.',
  503: 'No provider is currently available for this model.',
};

export function friendlyError(status: number, detail?: string): string {
  const base = STATUS_MESSAGES[status] ?? `OpenRouter error (${status}).`;
  return detail ? `${base} (${detail})` : base;
}

function extractDetail(body: string): string | undefined {
  try {
    const message = JSON.parse(body)?.error?.message;
    return typeof message === 'string' && message ? message : undefined;
  } catch {
    return undefined;
  }
}

const toPrice = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
};

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: Usage };

export interface OpenRouterClient {
  listModels(): Promise<CatalogModel[]>;
  checkKey(apiKey: string): Promise<void>;
  complete(o: { apiKey: string; model: string; messages: ChatMessage[]; maxTokens?: number }): Promise<string>;
  streamChat(o: { apiKey: string; model: string; messages: ChatMessage[]; signal?: AbortSignal }): AsyncGenerator<StreamEvent>;
}

export function createOpenRouterClient(fetchImpl: typeof fetch = fetch, base = OPENROUTER_BASE): OpenRouterClient {
  async function request(path: string, init: RequestInit & { apiKey?: string } = {}): Promise<Response> {
    const { apiKey, ...rest } = init;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'OpenChat',
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { ...rest, headers });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new OpenRouterError('Could not reach OpenRouter. Check your internet connection.', 0);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OpenRouterError(friendlyError(res.status, extractDetail(body)), res.status);
    }
    return res;
  }

  return {
    async listModels() {
      const res = await request('/models');
      const json = (await res.json()) as { data?: any[] };
      return (json.data ?? []).map((m) => ({
        id: String(m.id),
        name: String(m.name ?? m.id),
        contextLength: typeof m.context_length === 'number' ? m.context_length : null,
        promptPrice: toPrice(m.pricing?.prompt),
        completionPrice: toPrice(m.pricing?.completion),
      }));
    },

    async checkKey(apiKey) {
      await request('/key', { apiKey });
    },

    async complete({ apiKey, model, messages, maxTokens }) {
      const res = await request('/chat/completions', {
        method: 'POST',
        apiKey,
        body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      });
      const json = (await res.json()) as any;
      return String(json.choices?.[0]?.message?.content ?? '');
    },

    async *streamChat({ apiKey, model, messages, signal }) {
      const res = await request('/chat/completions', {
        method: 'POST',
        apiKey,
        signal,
        body: JSON.stringify({ model, messages, stream: true, usage: { include: true } }),
      });
      if (!res.body) throw new OpenRouterError('Empty response from OpenRouter.', 502);
      for await (const { data } of parseSSE(res.body)) {
        if (data === '[DONE]') return;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          const status = Number(chunk.error.code) || 502;
          throw new OpenRouterError(friendlyError(status, chunk.error.message), status);
        }
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.reasoning) yield { type: 'reasoning', text: delta.reasoning };
        if (delta?.content) yield { type: 'delta', text: delta.content };
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? null,
              completionTokens: chunk.usage.completion_tokens ?? null,
              cost: typeof chunk.usage.cost === 'number' ? chunk.usage.cost : null,
            },
          };
        }
      }
    },
  };
}
