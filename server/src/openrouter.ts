import { parseSSE } from '../../shared/sse';
import type { CatalogModel, Category, Source } from '../../shared/types';
import type { ChatMessage, Plugin } from './prompt';
import { parseImageModel, type ImageModel, type ImageSettings } from '../../shared/imageModels';

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

const toCount = (value: unknown): number | null => (typeof value === 'number' && value > 0 ? value : null);

/** Like toCount but keeps 0: a reported zero (e.g. no cache hit) differs from "not reported". */
const toTokens = (value: unknown): number | null => (typeof value === 'number' && value >= 0 ? value : null);

function parseUsage(raw: any): Usage {
  return {
    promptTokens: raw.prompt_tokens ?? null,
    completionTokens: raw.completion_tokens ?? null,
    cost: typeof raw.cost === 'number' ? raw.cost : null,
    webSearches: toCount(raw.server_tool_use_details?.web_search_requests),
    cachedTokens: toTokens(raw.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: toTokens(raw.prompt_tokens_details?.cache_write_tokens),
    reasoningTokens: toTokens(raw.completion_tokens_details?.reasoning_tokens),
  };
}

const toStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  /** Searches OpenRouter's web search tool ran; null when not reported (no search, or the plugin). */
  webSearches: number | null;
  /** Prompt tokens read from the provider's cache; null when not reported. */
  cachedTokens: number | null;
  /** Prompt tokens written to the cache (some providers only); null when not reported. */
  cacheWriteTokens: number | null;
  /** Reasoning share of the completion tokens; null when not reported. */
  reasoningTokens: number | null;
}

/** 'tool': the model decides when to search (needs tool support). 'plugin': one search per reply, any model. */
export type WebSearchMode = 'tool' | 'plugin';

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'usage'; usage: Usage };

const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** Streamed `url_citation` annotations as sources; anything that isn't an http(s) link is dropped, as are snippets. */
export function toSources(annotations: unknown): Source[] {
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((a) => {
    const cite = a?.type === 'url_citation' ? a.url_citation : undefined;
    if (typeof cite?.url !== 'string' || !isWebUrl(cite.url)) return [];
    return [{ url: cite.url, title: typeof cite.title === 'string' ? cite.title : '' }];
  });
}

/** Request fields for web search. The tool's 3-call cap bounds the cost of one reply. */
function searchFields(mode: WebSearchMode | undefined, plugins: Plugin[] | undefined): Record<string, unknown> {
  const all: object[] = [...(plugins ?? [])];
  const fields: Record<string, unknown> = {};
  if (mode === 'tool') {
    fields.tools = [{ type: 'openrouter:web_search', parameters: { max_results: 5 } }];
    fields.max_tool_calls = 3;
  } else if (mode === 'plugin') {
    all.push({ id: 'web', max_results: 5 });
  }
  if (all.length) fields.plugins = all;
  return fields;
}

export interface OpenRouterClient {
  listModels(): Promise<CatalogModel[]>;
  listCategory(category: Category): Promise<string[]>;
  checkKey(apiKey: string): Promise<void>;
  complete(o: { apiKey: string; model: string; messages: ChatMessage[]; maxTokens?: number; onUsage?: (usage: Usage) => void }): Promise<string>;
  streamChat(o: {
    apiKey: string; model: string; messages: ChatMessage[]; plugins?: Plugin[]; webSearch?: WebSearchMode; signal?: AbortSignal;
  }): AsyncGenerator<StreamEvent>;
  /** Image models with their pricing; a model whose pricing can't be fetched is listed with an unknown price. */
  listImageModels(): Promise<ImageModel[]>;
  /** One image; `references` are data URLs of the images to edit or draw on. */
  generateImage(o: { apiKey: string; model: string; prompt: string; settings: ImageSettings; references: string[] }): Promise<GeneratedImage>;
}

export interface GeneratedImage {
  data: Buffer;
  mime: string;
  usage: Usage | null;
}

/** The image's type from its first bytes; PNG when unrecognised (OpenRouter's default). */
function sniffImage(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'image/png';
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
      return (json.data ?? []).map((m) => {
        const params = toStrings(m.supported_parameters);
        const inputs = toStrings(m.architecture?.input_modalities);
        return {
          id: String(m.id),
          name: String(m.name ?? m.id),
          contextLength: typeof m.context_length === 'number' ? m.context_length : null,
          promptPrice: toPrice(m.pricing?.prompt),
          completionPrice: toPrice(m.pricing?.completion),
          description: typeof m.description === 'string' ? m.description : '',
          created: typeof m.created === 'number' ? m.created : null,
          inputModalities: inputs.length ? inputs : ['text'],
          supportsTools: params.includes('tools'),
          supportsReasoning: params.includes('reasoning'),
          maxOutput: toCount(m.top_provider?.max_completion_tokens),
          cacheReadPrice: toPrice(m.pricing?.input_cache_read),
        };
      });
    },

    async listCategory(category) {
      const res = await request(`/models?category=${encodeURIComponent(category)}`);
      const json = (await res.json()) as { data?: any[] };
      return (json.data ?? []).map((m) => String(m.id));
    },

    async checkKey(apiKey) {
      await request('/key', { apiKey });
    },

    async complete({ apiKey, model, messages, maxTokens, onUsage }) {
      const res = await request('/chat/completions', {
        method: 'POST',
        apiKey,
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, usage: { include: true } }),
      });
      const json = (await res.json()) as any;
      if (json.usage) onUsage?.(parseUsage(json.usage));
      return String(json.choices?.[0]?.message?.content ?? '');
    },

    async listImageModels() {
      const res = await request('/images/models');
      const entries = ((await res.json()) as { data?: any[] }).data ?? [];
      const endpoints = await mapLimited(entries, 6, async (m) => {
        try {
          return await (await request(`/images/models/${String(m.id)}/endpoints`)).json();
        } catch {
          return null;
        }
      });
      return entries.flatMap((m, i) => parseImageModel(m, endpoints[i]) ?? []);
    },

    async generateImage({ apiKey, model, prompt, settings, references }) {
      const body: Record<string, unknown> = { model, prompt, n: 1, aspect_ratio: settings.aspect };
      if (settings.size) body.resolution = settings.size;
      if (settings.quality) body.quality = settings.quality;
      if (settings.transparent) body.background = 'transparent';
      if (references.length) body.input_references = references;
      const res = await request('/images', { method: 'POST', apiKey, body: JSON.stringify(body) });
      const json = (await res.json()) as { data?: { b64_json?: string; media_type?: string }[]; usage?: unknown };
      const image = json.data?.[0];
      if (!image?.b64_json) throw new OpenRouterError('The model returned no image.', 502);
      const data = Buffer.from(image.b64_json, 'base64');
      return { data, mime: image.media_type ?? sniffImage(data), usage: json.usage ? parseUsage(json.usage) : null };
    },

    async *streamChat({ apiKey, model, messages, plugins, webSearch, signal }) {
      const res = await request('/chat/completions', {
        method: 'POST',
        apiKey,
        signal,
        body: JSON.stringify({ model, messages, stream: true, usage: { include: true }, ...searchFields(webSearch, plugins) }),
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
        if (delta?.annotations) {
          const sources = toSources(delta.annotations);
          if (sources.length) yield { type: 'sources', sources };
        }
        if (chunk.usage) yield { type: 'usage', usage: parseUsage(chunk.usage) };
      }
    },
  };
}
