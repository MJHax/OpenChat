import type { Deps } from '../app';
import { HttpError } from '../http';
import { getServer } from '../localServers';
import { resolveApiKey } from '../settings';
import { createLmStudioClient } from './lmstudio';
import { createOllamaClient } from './ollama';
import { createOpenAICompatClient } from './openaiCompat';
import { LocalServerError, ProviderError, type ChatProvider, type LocalClient } from './types';
import { defaultContextWindow, parseLocalModelId } from '../../../shared/localModels';
import type { LocalServer } from '../../../shared/types';

export function localClientFor(server: LocalServer): LocalClient {
  switch (server.type) {
    case 'ollama': return createOllamaClient(server);
    case 'lmstudio': return createLmStudioClient(server);
    case 'openai': return createOpenAICompatClient(server);
  }
}

/** The window a local model runs with: the one chosen for it, else the default for its maximum. */
function windowFor(deps: Deps, modelId: string): number {
  const row = deps.db.prepare('SELECT context_window, context_length FROM models WHERE id = ?').get(modelId) as
    | { context_window: number | null; context_length: number | null }
    | undefined;
  return row?.context_window ?? defaultContextWindow(row?.context_length ?? null);
}

function supportsReasoning(deps: Deps, modelId: string): boolean {
  const row = deps.db.prepare('SELECT supports_reasoning FROM models WHERE id = ?').get(modelId) as { supports_reasoning: number } | undefined;
  return row?.supports_reasoning === 1;
}

/**
 * The provider that serves `modelId`: its local server for a local id, OpenRouter otherwise. Throws a ProviderError
 * when the model can't be served right now (server removed or off, no OpenRouter key).
 */
export function chatProvider(deps: Deps, modelId: string): ChatProvider {
  const local = parseLocalModelId(modelId);
  if (local) {
    const server = getServer(deps.db, local.serverId);
    if (!server) throw new LocalServerError('The server for this model was removed.', 404);
    if (!server.enabled) throw new LocalServerError(`${server.name} is turned off in Settings.`, 409);
    const client = localClientFor(server);
    const contextWindow = windowFor(deps, modelId);
    // Helper calls (titles, summaries, suggestions) must not spend their small budget on thinking.
    const helperThink = supportsReasoning(deps, modelId) ? false : undefined;
    return {
      streamChat: (o) => client.streamChat({ ...o, model: local.name, contextWindow }),
      complete: (o) => client.complete({ ...o, model: local.name, contextWindow, think: o.think ?? helperThink }),
    };
  }
  const { key } = resolveApiKey(deps.db, deps.env);
  if (!key) throw new ProviderError('No OpenRouter API key set. Add one in Settings.', 401);
  return {
    streamChat: ({ think: _think, ...o }) => deps.openrouter.streamChat({ ...o, apiKey: key }),
    complete: ({ think: _think, ...o }) => deps.openrouter.complete({ ...o, apiKey: key }),
  };
}

/** Like chatProvider, for routes that answer with an HttpError: a missing key is the caller's to fix (400). */
export function chatProviderOrHttp(deps: Deps, modelId: string): ChatProvider {
  try {
    return chatProvider(deps, modelId);
  } catch (err) {
    if (err instanceof ProviderError) throw new HttpError(err.status === 401 ? 400 : err.status, err.message);
    throw err;
  }
}
