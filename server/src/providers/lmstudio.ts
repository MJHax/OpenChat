import { LIST_TIMEOUT_MS, createOpenAIChat } from './openaiCompat';
import { localFetch, readListing } from './localHttp';
import type { LocalClient, LocalModelInfo } from './types';

/** LM Studio's native REST API (`/api/v1`) lists models with capabilities and loads them; chat is OpenAI-compatible. */
export function createLmStudioClient(server: { name: string; baseUrl: string }, fetchImpl: typeof fetch = fetch): LocalClient {
  async function fetchModels(): Promise<any[]> {
    const body: any = await readListing(await localFetch(server, '/api/v1/models', { timeoutMs: LIST_TIMEOUT_MS }, fetchImpl), server);
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

    ...createOpenAIChat(server, fetchImpl, async ({ model, contextWindow, signal }) => {
      if (contextWindow === undefined) return;
      // If the model listing fails or stalls, skip the load step: the chat that follows reports a server that is really down.
      let info: any;
      try {
        info = (await fetchModels()).find((m) => m.key === model);
      } catch {
        return;
      }
      // A loaded model keeps the window it was loaded with; an unknown one is left for LM Studio to report on chat.
      if (!info || (info.loaded_instances ?? []).length > 0) return;
      await localFetch(
        server,
        '/api/v1/models/load',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, context_length: contextWindow }), signal },
        fetchImpl,
      );
    }),
  };
}
