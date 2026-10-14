import type { LibraryModel, Message } from '../../../shared/types';

/** The model a chat opens with: the last library model that replied in it, else the default model. */
export function initialModelId(messages: Pick<Message, 'role' | 'modelId'>[], models: LibraryModel[]): string {
  const ids = new Set(models.map((m) => m.id));
  const lastUsed = [...messages].reverse().find((m) => m.role === 'assistant' && m.modelId && ids.has(m.modelId))?.modelId;
  return lastUsed ?? (models.find((m) => m.isDefault) ?? models[0])?.id ?? '';
}
