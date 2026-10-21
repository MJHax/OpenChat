import { LIST_TIMEOUT_MS, createOpenAIChat } from './openaiCompat';
import { localFetch, readListing } from './localHttp';
import type { LoadState, LocalClient, LocalModelInfo } from './types';

/** The pre-chat listing runs while LM Studio may be busy loading another model, so it gets longer than a settings-page listing. */
const PREPARE_TIMEOUT_MS = 10_000;

/** LM Studio's native REST API (`/api/v1`) lists models with capabilities and loads them; chat is OpenAI-compatible. */
export function createLmStudioClient(server: { name: string; baseUrl: string }, fetchImpl: typeof fetch = fetch): LocalClient {
  async function fetchModels(timeoutMs = LIST_TIMEOUT_MS): Promise<any[]> {
    const body: any = await readListing(await localFetch(server, '/api/v1/models', { timeoutMs }, fetchImpl), server);
    return (body.models ?? []).filter((m: any) => m.type !== 'embedding' && m.type !== 'decision');
  }

  return {
    async listModels() {
      return (await fetchModels()).map(
        (m: any): LocalModelInfo => ({
          name: String(m.key),
          sizeBytes: typeof m.size_bytes === 'number' ? m.size_bytes : null,
          contextLength: typeof m.max_context_length === 'number' ? m.max_context_length : null,
          inputModalities: m.capabilities?.vision ? ['text', 'image'] : ['text'],
          supportsTools: m.capabilities?.trained_for_tool_use === true,
          supportsReasoning: false,
          capsKnown: true,
        }),
      );
    },

    async loadState(model): Promise<LoadState | null> {
      try {
        const info = (await fetchModels(PREPARE_TIMEOUT_MS)).find((m) => m.key === model);
        if (!info) return null;
        const instances: any[] = info.loaded_instances ?? [];
        const ctx = instances[0]?.config?.context_length;
        return { loaded: instances.length > 0, contextWindow: typeof ctx === 'number' ? ctx : null };
      } catch {
        return null;
      }
    },

    ...createOpenAIChat(server, fetchImpl, async ({ model, contextWindow, signal }) => {
      if (contextWindow === undefined) return null;
      // If the model listing fails or stalls, skip the load step: the chat that follows reports a server that is really down.
      let info: any;
      try {
        info = (await fetchModels(PREPARE_TIMEOUT_MS)).find((m) => m.key === model);
      } catch {
        return null;
      }
      // A loaded model keeps the window it was loaded with; an unknown one is left for LM Studio to report on chat.
      if (!info || (info.loaded_instances ?? []).length > 0) return null;
      const started = Date.now();
      const res = await localFetch(
        server,
        '/api/v1/models/load',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, context_length: contextWindow }), signal },
        fetchImpl,
      );
      let seconds: unknown;
      try {
        seconds = ((await res.json()) as any)?.load_time_seconds;
      } catch {
        // an unreadable answer falls back to the measured time
      }
      return typeof seconds === 'number' ? Math.round(seconds * 1000) : Date.now() - started;
    }),
  };
}
