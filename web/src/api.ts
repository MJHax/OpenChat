import { parseSSE } from '../../shared/sse';
import type {
  CatalogResponse, ChatDetail, ChatSummary, LibraryModel, Memory, SearchHit, SettingsUpdate, SettingsView,
  StreamDone, StreamError, StreamStart, StreamTitle,
} from '../../shared/types';

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
  listChats: () => json<ChatSummary[]>('GET', '/api/chats'),
  createChat: () => json<ChatSummary>('POST', '/api/chats'),
  getChat: (id: string) => json<ChatDetail>('GET', `/api/chats/${id}`),
  renameChat: (id: string, title: string) => json<ChatDetail>('PATCH', `/api/chats/${id}`, { title }),
  selectMessage: (id: string, messageId: string) => json<ChatDetail>('PATCH', `/api/chats/${id}`, { selectMessageId: messageId }),
  deleteChat: (id: string) => json<{ ok: true }>('DELETE', `/api/chats/${id}`),
  search: (q: string) => json<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),

  listModels: () => json<LibraryModel[]>('GET', '/api/models'),
  catalog: (refresh = false) => json<CatalogResponse>('GET', `/api/models/catalog${refresh ? '?refresh=1' : ''}`),
  addModel: (id: string) => json<LibraryModel[]>('POST', '/api/models', { id }),
  updateModel: (patch: { id: string; displayName?: string; isDefault?: boolean }) => json<LibraryModel[]>('PATCH', '/api/models', patch),
  removeModel: (id: string) => json<LibraryModel[]>('DELETE', `/api/models?id=${encodeURIComponent(id)}`),

  getSettings: () => json<SettingsView>('GET', '/api/settings'),
  updateSettings: (update: SettingsUpdate) => json<SettingsView>('PUT', '/api/settings', update),
  testKey: () => json<{ ok: boolean; error?: string }>('POST', '/api/settings/test-key'),

  listMemories: () => json<Memory[]>('GET', '/api/memories'),
  addMemory: (content: string) => json<Memory>('POST', '/api/memories', { content }),
  updateMemory: (id: number, patch: { content?: string; enabled?: boolean }) => json<Memory>('PATCH', `/api/memories/${id}`, patch),
  deleteMemory: (id: number) => json<{ ok: true }>('DELETE', `/api/memories/${id}`),
};

export interface StreamHandlers {
  onStart(e: StreamStart): void;
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onDone(e: StreamDone): void;
  onError(e: StreamError): void;
  onTitle(e: StreamTitle): void;
}

/** POSTs to a generation endpoint and dispatches its SSE events. Rejects with AbortError when `signal` aborts. */
export async function streamGeneration(url: string, body: unknown, h: StreamHandlers, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    h.onError({ message: data.error ?? `Request failed (${res.status})`, partial: null });
    return;
  }
  for await (const ev of parseSSE(res.body)) {
    const data = JSON.parse(ev.data);
    if (ev.event === 'start') h.onStart(data);
    else if (ev.event === 'delta') h.onDelta(data.text);
    else if (ev.event === 'reasoning') h.onReasoning(data.text);
    else if (ev.event === 'done') h.onDone(data);
    else if (ev.event === 'error') h.onError(data);
    else if (ev.event === 'title') h.onTitle(data);
  }
}
