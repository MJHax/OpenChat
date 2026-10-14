import type { Deps } from './app';
import { HttpError } from './http';
import { OpenRouterError } from './openrouter';
import { getSetting, resolveApiKey } from './settings';

export const MEMORY_PROMPT =
  'Turn the following text into one short fact worth remembering about the user, written in the third person ' +
  '(for example "User lives in a small farming town."). If the text says nothing about the user, state its key ' +
  'point as a single short fact instead. Reply with the fact only.';

/** First non-empty line, without surrounding quotes, list markers or markdown emphasis, at most 300 characters. */
export function cleanFact(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line
    .replace(/^[-*#>\s"'`]+/, '')
    .replace(/["'`*\s]+$/, '')
    .slice(0, 300);
}

export async function suggestMemory(deps: Deps, text: unknown): Promise<string> {
  const { db, env, openrouter } = deps;
  const input = typeof text === 'string' ? text.trim() : '';
  if (!input) throw new HttpError(400, 'Nothing to remember.');
  const model = getSetting(db, 'memory_model_id') || getSetting(db, 'default_model_id');
  if (!model) throw new HttpError(400, 'Add a model in the Model Library first.');
  const { key } = resolveApiKey(db, env);
  if (!key) throw new HttpError(400, 'No OpenRouter API key set. Add one in Settings.');

  let raw: string;
  try {
    raw = await openrouter.complete({
      apiKey: key,
      model,
      // Reasoning models think before answering; a small budget is spent entirely on reasoning.
      maxTokens: 1000,
      messages: [
        { role: 'system', content: MEMORY_PROMPT },
        { role: 'user', content: input.slice(0, 4000) },
      ],
    });
  } catch (err) {
    throw new HttpError(502, err instanceof OpenRouterError ? err.message : 'Could not reach the memory model.');
  }
  const fact = cleanFact(raw);
  if (!fact) throw new HttpError(502, "The model didn't suggest anything. Type the fact yourself.");
  return fact;
}
