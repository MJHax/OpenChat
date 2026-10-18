import { parseSSE } from '../../shared/sse';
import type {
  Attachment, CatalogResponse, ChatDetail, ChatSummary, CompareDone, CompareSlotDone, CompareSlotError, CompareStart, LibraryModel, Memory,
  Message, SearchHit, SettingsUpdate, SettingsView, StreamDone, StreamError, StreamStart, StreamTitle, StatsRange, StatsResponse, ChatStats, ContextUsage,
  GeneratedItems, MediaCatalog, MediaKind, MediaLibraryModel, MediaStatsResponse, MediaThreadStats, ThreadKind, StorageUsage, DeleteTarget, LimitStatus,
} from '../../shared/types';
import type { ImageSettings } from '../../shared/imageModels';
import type { VideoSettings } from '../../shared/videoModels';

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  listChats: (kind: ThreadKind = 'chat') => json<ChatSummary[]>('GET', `/api/chats?kind=${kind}`),
  createChat: (kind: ThreadKind = 'chat', instructions?: string) => json<ChatSummary>('POST', '/api/chats', { kind, instructions }),
  setInstructions: (id: string, instructions: string) => json<ChatDetail>('PATCH', `/api/chats/${id}`, { instructions }),
  setContextNote: (id: string, contextNote: string) => json<ChatDetail>('PATCH', `/api/chats/${id}`, { contextNote }),
  /** "Summarize and continue": resolves with the new chat once the summary is written. */
  continueChat: (id: string, modelId: string) => json<ChatSummary>('POST', `/api/chats/${id}/continue`, { modelId }),
  getChat: (id: string) => json<ChatDetail>('GET', `/api/chats/${id}`),
  renameChat: (id: string, title: string) => json<ChatDetail>('PATCH', `/api/chats/${id}`, { title }),
  selectMessage: (id: string, messageId: string) => json<ChatDetail>('PATCH', `/api/chats/${id}`, { selectMessageId: messageId }),
  deleteChat: (id: string) => json<{ ok: true }>('DELETE', `/api/chats/${id}`),
  replies: (chatId: string, parentId: string) =>
    json<Message[]>('GET', `/api/chats/${chatId}/replies?parentId=${encodeURIComponent(parentId)}`),
  search: (q: string) => json<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  chatStats: (id: string) => json<ChatStats>('GET', `/api/chats/${id}/stats`),
  /** `instructions` are a new chat's draft; a saved chat's own are read on the server. */
  context: (modelId: string, chatId: string | null, instructions = '') =>
    json<ContextUsage>('GET', `/api/context?model=${encodeURIComponent(modelId)}${chatId ? `&chat=${encodeURIComponent(chatId)}`
      : instructions ? `&instructions=${encodeURIComponent(instructions)}` : ''}`),
  stats: (range: StatsRange, tz: string) => json<StatsResponse>('GET', `/api/stats?range=${range}&tz=${encodeURIComponent(tz)}`),

  listModels: () => json<LibraryModel[]>('GET', '/api/models'),
  catalog: (refresh = false) => json<CatalogResponse>('GET', `/api/models/catalog${refresh ? '?refresh=1' : ''}`),
  addModel: (id: string) => json<LibraryModel[]>('POST', '/api/models', { id }),
  updateModel: (patch: { id: string; displayName?: string; isDefault?: boolean }) => json<LibraryModel[]>('PATCH', '/api/models', patch),
  removeModel: (id: string) => json<LibraryModel[]>('DELETE', `/api/models?id=${encodeURIComponent(id)}`),

  generateImage: (threadId: string, body: {
    prompt: string; modelId: string; settings: ImageSettings; targetAttachmentId: string | null; attachmentIds: string[]; parentId?: string;
  }) => json<{ userMessageId: string; assistantMessageId: string }>('POST', `/api/chats/${threadId}/images`, body),
  generateVideo: (threadId: string, body: {
    prompt: string; modelId: string; settings: VideoSettings; startAttachmentId: string | null; endAttachmentId: string | null;
  }) => json<{ userMessageId: string; assistantMessageId: string }>('POST', `/api/chats/${threadId}/videos`, body),
  mediaThreadStats: (id: string) => json<MediaThreadStats>('GET', `/api/chats/${id}/stats`),
  mediaStats: (view: 'images' | 'video', range: StatsRange, tz: string) =>
    json<MediaStatsResponse>('GET', `/api/stats?view=${view}&range=${range}&tz=${encodeURIComponent(tz)}`),
  generated: () => json<GeneratedItems>('GET', '/api/attachments/generated'),
  copyGenerated: (source: { attachmentId: string } | { messageId: string; name: string }) => json<Attachment>('POST', '/api/attachments/copy', source),

  listMediaModels: (kind: MediaKind) => json<MediaLibraryModel[]>('GET', `/api/media-models?kind=${kind}`),
  mediaCatalog: (kind: MediaKind, refresh = false) => json<MediaCatalog>('GET', `/api/media-models/catalog?kind=${kind}${refresh ? '&refresh=1' : ''}`),
  addMediaModel: (id: string, kind: MediaKind) => json<MediaLibraryModel[]>('POST', '/api/media-models', { id, kind }),
  removeMediaModel: (id: string, kind: MediaKind) =>
    json<MediaLibraryModel[]>('DELETE', `/api/media-models?id=${encodeURIComponent(id)}&kind=${kind}`),

  getSettings: () => json<SettingsView>('GET', '/api/settings'),
  updateSettings: (update: SettingsUpdate) => json<SettingsView>('PUT', '/api/settings', update),
  testKey: () => json<{ ok: boolean; error?: string }>('POST', '/api/settings/test-key'),
  limits: () => json<LimitStatus[]>('GET', '/api/settings/limits'),

  storage: () => json<StorageUsage>('GET', '/api/data/storage'),
  cleanUp: () => json<StorageUsage>('POST', '/api/data/cleanup'),
  deleteData: (target: DeleteTarget, confirm: string) => json<{ ok: true; chatIds: string[] }>('POST', '/api/data/delete', { target, confirm }),

  listMemories: () => json<Memory[]>('GET', '/api/memories'),
  addMemory: (content: string) => json<Memory>('POST', '/api/memories', { content }),
  updateMemory: (id: number, patch: { content?: string; enabled?: boolean }) => json<Memory>('PATCH', `/api/memories/${id}`, patch),
  deleteMemory: (id: number) => json<{ ok: true }>('DELETE', `/api/memories/${id}`),
  suggestMemory: (text: string) => json<{ suggestion: string }>('POST', '/api/memories/suggest', { text }).then((r) => r.suggestion),
};

/** Uploads one file, reporting progress from 0 to 1. Rejects with the server's error message. */
export function uploadAttachment(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      const data = xhr.response as (Attachment & { error?: string }) | null;
      if (xhr.status === 201 && data) resolve(data);
      else reject(new Error(data?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check that OpenChat is still running.'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
    signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export const deleteAttachment = (id: string) => json<{ ok: true }>('DELETE', `/api/attachments/${id}`).then(() => undefined);

export const attachmentUrl = (id: string): string => `/api/attachments/${id}`;
export const videoUrl = (messageId: string): string => `/api/videos/${messageId}`;

export interface StreamHandlers {
  onStart(e: StreamStart): void;
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onDone(e: StreamDone): void;
  onError(e: StreamError): void;
  onTitle(e: StreamTitle): void;
}

/** POSTs to a generation endpoint; returns its SSE events, or reports an HTTP error through `onError`. */
async function postStream(url: string, body: unknown, signal: AbortSignal, onError: (e: StreamError) => void) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    onError({ message: data.error ?? `Request failed (${res.status})`, partial: null });
    return null;
  }
  return parseSSE(res.body);
}

/** Streams a single-model reply. Rejects with AbortError when `signal` aborts. */
export async function streamGeneration(url: string, body: unknown, h: StreamHandlers, signal: AbortSignal): Promise<void> {
  const events = await postStream(url, body, signal, h.onError);
  if (!events) return;
  for await (const ev of events) {
    const data = JSON.parse(ev.data);
    if (ev.event === 'start') h.onStart(data);
    else if (ev.event === 'delta') h.onDelta(data.text);
    else if (ev.event === 'reasoning') h.onReasoning(data.text);
    else if (ev.event === 'done') h.onDone(data);
    else if (ev.event === 'error') h.onError(data);
    else if (ev.event === 'title') h.onTitle(data);
  }
}

export interface CompareHandlers {
  onStart(e: CompareStart): void;
  onDelta(slot: number, text: string): void;
  onReasoning(slot: number, text: string): void;
  onSlotDone(e: CompareSlotDone): void;
  onSlotError(e: CompareSlotError): void;
  onDone(e: CompareDone): void;
  onError(e: StreamError): void;
  onTitle(e: StreamTitle): void;
}

/** Streams a comparison (body has `modelIds`). Rejects with AbortError when `signal` aborts. */
export async function streamComparison(url: string, body: unknown, h: CompareHandlers, signal: AbortSignal): Promise<void> {
  const events = await postStream(url, body, signal, h.onError);
  if (!events) return;
  for await (const ev of events) {
    const data = JSON.parse(ev.data);
    if (ev.event === 'start') h.onStart(data);
    else if (ev.event === 'delta') h.onDelta(data.slot, data.text);
    else if (ev.event === 'reasoning') h.onReasoning(data.slot, data.text);
    else if (ev.event === 'slot-done') h.onSlotDone(data);
    else if (ev.event === 'slot-error') h.onSlotError(data);
    else if (ev.event === 'done') h.onDone(data);
    else if (ev.event === 'title') h.onTitle(data);
  }
}
