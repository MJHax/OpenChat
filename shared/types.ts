export type Role = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'stopped';
export type Theme = 'light' | 'dark' | 'system';

export interface Message {
  id: string;
  chatId: string;
  parentId: string | null;
  role: Role;
  content: string;
  modelId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  status: MessageStatus;
  createdAt: number;
}

/** A message on the active path, with its sibling versions (same parent), oldest first. */
export interface PathMessage extends Message {
  siblingIds: string[];
  siblingIndex: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  totalCost: number;
}

export interface ChatDetail {
  chat: ChatSummary & { activeLeafId: string | null };
  messages: PathMessage[];
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per token; null if unknown, negative means "varies" (e.g. openrouter/auto). */
  promptPrice: number | null;
  completionPrice: number | null;
}

export interface CatalogResponse {
  models: CatalogModel[];
  fetchedAt: number;
  stale: boolean;
}

export interface LibraryModel {
  id: string;
  displayName: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  isDefault: boolean;
}

export interface Memory {
  id: number;
  content: string;
  enabled: boolean;
  createdAt: number;
}

export interface SettingsView {
  hasApiKey: boolean;
  apiKeySource: 'settings' | 'env' | 'none';
  apiKeyMasked: string;
  aboutMe: string;
  customInstructions: string;
  theme: Theme;
  defaultModelId: string;
  titleModelId: string;
}

export type SettingsUpdate = Partial<{
  apiKey: string;
  aboutMe: string;
  customInstructions: string;
  theme: Theme;
  defaultModelId: string;
  titleModelId: string;
}>;

export interface SearchHit {
  chatId: string;
  chatTitle: string;
  messageId: string;
  /** Matched text wrapped in « and ». */
  snippet: string;
}

// Server-sent events emitted by /messages, /regenerate and /edit
export interface StreamStart { userMessageId: string | null; assistantMessageId: string }
export interface StreamDelta { text: string }
export interface StreamDone { message: Message }
export interface StreamError { message: string; partial: Message | null }
export interface StreamTitle { title: string }
