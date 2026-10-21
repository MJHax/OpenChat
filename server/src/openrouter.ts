import type { CatalogModel, Category, Effort, Source } from '../../shared/types';
import type { ChatMessage, Plugin } from './prompt';
import { parseImageModel, type ImageModel, type ImageSettings } from '../../shared/imageModels';
import { parseVideoModel, type VideoModel } from '../../shared/videoModels';
import { isSvg, SVG_MIME } from './svg';
import { ProviderError } from './providers/types';
import { readChatStream } from './providers/openaiStream';

export { toSources } from './providers/openaiStream';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends ProviderError {
  constructor(message: string, status: number) {
    super(message, status);
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
    loadMs: null,
    generationMs: null,
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
  /** Local models only: milliseconds the server spent loading the model for this reply; null when not reported or not loaded. */
  loadMs: number | null;
  /** Local models only: milliseconds the server spent generating; null when not reported. */
  generationMs: number | null;
}

/** 'tool': the model decides when to search (needs tool support). 'plugin': one search per reply, any model. */
export type WebSearchMode = 'tool' | 'plugin';

/** A function the model may call; `parameters` is a JSON Schema object. */
export interface FunctionTool {
  name: string;
  description: string;
  parameters: object;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'usage'; usage: Usage }
  /** A finished function call, emitted once the stream ends; `arguments` is the model's raw JSON text. */
  | { type: 'tool_call'; name: string; arguments: string };

/** Request fields for web search and function tools. The search tool's 3-call cap bounds the cost of one reply. */
function toolFields(mode: WebSearchMode | undefined, plugins: Plugin[] | undefined, functions: FunctionTool[] | undefined): Record<string, unknown> {
  const all: object[] = [...(plugins ?? [])];
  const tools: object[] = [];
  const fields: Record<string, unknown> = {};
  if (mode === 'tool') {
    tools.push({ type: 'openrouter:web_search', parameters: { max_results: 5 } });
    fields.max_tool_calls = 3;
  } else if (mode === 'plugin') {
    all.push({ id: 'web', max_results: 5 });
  }
  if (functions?.length) {
    tools.push(...functions.map((f) => ({ type: 'function', function: f })));
    fields.tool_choice = 'auto';
  }
  if (tools.length) fields.tools = tools;
  if (all.length) fields.plugins = all;
  return fields;
}

export interface OpenRouterClient {
  listModels(): Promise<CatalogModel[]>;
  listCategory(category: Category): Promise<string[]>;
  checkKey(apiKey: string): Promise<void>;
  complete(o: { apiKey: string; model: string; messages: ChatMessage[]; maxTokens?: number; onUsage?: (usage: Usage) => void }): Promise<string>;
  streamChat(o: {
    apiKey: string; model: string; messages: ChatMessage[]; plugins?: Plugin[]; webSearch?: WebSearchMode; tools?: FunctionTool[]; signal?: AbortSignal;
    /** Only for models that support reasoning; left out, the model uses its own default. */
    effort?: Effort;
  }): AsyncGenerator<StreamEvent>;
  /** Image models with their pricing; a model whose pricing can't be fetched is listed with an unknown price. */
  listImageModels(): Promise<ImageModel[]>;
  /** One image; `references` are data URLs of the images to edit or draw on. */
  generateImage(o: { apiKey: string; model: string; prompt: string; settings: ImageSettings; references: string[] }): Promise<GeneratedImage>;
  listVideoModels(): Promise<VideoModel[]>;
  /** Starts a video job; it runs on OpenRouter for minutes. */
  submitVideo(o: { apiKey: string; body: object }): Promise<{ jobId: string; pollingUrl: string }>;
  /** A job's status: pending / in_progress while running, then completed, failed, cancelled or expired. */
  getVideoJob(o: { apiKey: string; jobId: string; pollingUrl: string }): Promise<{ status: string; error: string | null; usage: Usage | null }>;
  downloadVideo(o: { apiKey: string; jobId: string }): Promise<ReadableStream<Uint8Array>>;
}

export interface GeneratedImage {
  data: Buffer;
  mime: string;
  usage: Usage | null;
}

const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** The image's type from its first bytes; PNG when unrecognised (OpenRouter's default). */
function sniffImage(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (isSvg(b)) return SVG_MIME;
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

/** OpenRouter identifies an app by its HTTP-Referer (so not a localhost URL, which every local app shares) and shows its title. */
const APP_URL = 'https://github.com/MJHax/OpenChat';
const APP_TITLE = 'OpenChat';

export function createOpenRouterClient(fetchImpl: typeof fetch = fetch, base = OPENROUTER_BASE): OpenRouterClient {
  async function request(path: string, init: RequestInit & { apiKey?: string } = {}): Promise<Response> {
    const { apiKey, ...rest } = init;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_URL,
      'X-OpenRouter-Title': APP_TITLE,
      'X-Title': APP_TITLE, // the older name for the same header, still accepted
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // A video job's polling URL may come back absolute; everything else is a path under the API base.
    const url = /^https?:\/\//.test(path) ? path : `${base}${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...rest, headers });
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

    async listVideoModels() {
      const res = await request('/videos/models');
      const entries = ((await res.json()) as { data?: any[] }).data ?? [];
      return entries.flatMap((m) => parseVideoModel(m) ?? []);
    },

    async submitVideo({ apiKey, body }) {
      const res = await request('/videos', { method: 'POST', apiKey, body: JSON.stringify(body) });
      const json = (await res.json()) as { id?: string; polling_url?: string };
      if (!json.id) throw new OpenRouterError('OpenRouter did not start the video job.', 502);
      return { jobId: json.id, pollingUrl: json.polling_url ?? `/api/v1/videos/${json.id}` };
    },

    async getVideoJob({ apiKey, jobId, pollingUrl }) {
      const url = new URL(pollingUrl || `/api/v1/videos/${jobId}`, new URL(base).origin).toString();
      const json = (await (await request(url, { apiKey })).json()) as { status?: string; error?: unknown; usage?: unknown };
      return {
        status: String(json.status ?? 'pending'),
        error: typeof json.error === 'string' ? json.error : json.error ? JSON.stringify(json.error) : null,
        usage: json.usage ? parseUsage(json.usage) : null,
      };
    },

    async downloadVideo({ apiKey, jobId }) {
      const res = await request(`/videos/${encodeURIComponent(jobId)}/content?index=0`, { apiKey });
      if (!res.body) throw new OpenRouterError('The video download was empty.', 502);
      return res.body;
    },

    async generateImage({ apiKey, model, prompt, settings, references }) {
      const body: Record<string, unknown> = { model, prompt, n: 1, aspect_ratio: settings.aspect };
      if (settings.size) body.resolution = settings.size;
      if (settings.quality) body.quality = settings.quality;
      if (settings.transparent) body.background = 'transparent';
      if (references.length) body.input_references = references.map((url) => ({ type: 'image_url', image_url: { url } }));
      const res = await request('/images', { method: 'POST', apiKey, body: JSON.stringify(body) });
      const json = (await res.json()) as { data?: { b64_json?: string; media_type?: string }[]; usage?: unknown };
      const image = json.data?.[0];
      if (!image?.b64_json) throw new OpenRouterError('The model returned no image.', 502);
      const data = Buffer.from(image.b64_json, 'base64');
      // SVG is taken from the bytes alone, never the reported type; it can carry script, so the attachment route serves it sandboxed.
      const sniffed = sniffImage(data);
      const mime = image.media_type && RASTER.has(image.media_type) && sniffed !== SVG_MIME ? image.media_type : sniffed;
      return { data, mime, usage: json.usage ? parseUsage(json.usage) : null };
    },

    async *streamChat({ apiKey, model, messages, plugins, webSearch, tools, signal, effort }) {
      const res = await request('/chat/completions', {
        method: 'POST',
        apiKey,
        signal,
        body: JSON.stringify({
          model, messages, stream: true, usage: { include: true }, ...toolFields(webSearch, plugins, tools), ...(effort ? { reasoning: { effort } } : {}),
        }),
      });
      if (!res.body) throw new OpenRouterError('Empty response from OpenRouter.', 502);
      yield* readChatStream(
        res.body,
        (status, message) => {
          throw new OpenRouterError(friendlyError(status, message), status);
        },
        parseUsage,
      );
    },
  };
}
