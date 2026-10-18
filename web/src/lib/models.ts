import type { LibraryModel, Message } from '../../../shared/types';

/** The model a chat opens with: the last library model that replied in it, else the default model. */
/** `preferred` (e.g. the model that summarized a continued chat) applies until some model in the library has replied. */
export function initialModelId(messages: Pick<Message, 'role' | 'modelId'>[], models: LibraryModel[], preferred?: string | null): string {
  const ids = new Set(models.map((m) => m.id));
  const lastUsed = [...messages].reverse().find((m) => m.role === 'assistant' && m.modelId && ids.has(m.modelId))?.modelId;
  const fallback = preferred && ids.has(preferred) ? preferred : undefined;
  return lastUsed ?? fallback ?? (models.find((m) => m.isDefault) ?? models[0])?.id ?? '';
}
