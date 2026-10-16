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
  /** Set while a comparison's replies are waiting for the user to pick one. */
  compare: { parentId: string; replies: Message[] } | null;
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per token; null if unknown, negative means "varies" (e.g. openrouter/auto). */
  promptPrice: number | null;
  completionPrice: number | null;
  description: string;
  /** Unix seconds when OpenRouter listed the model; null if unknown. */
  created: number | null;
  /** e.g. ['text', 'image', 'file']. */
  inputModalities: string[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  maxOutput: number | null;
}

/** Fills the fields older cache rows and fallback lookups don't carry. */
export function withCatalogDefaults(m: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    name: m.id,
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    description: '',
    created: null,
    inputModalities: ['text'],
    supportsTools: false,
    supportsReasoning: false,
    maxOutput: null,
    ...m,
  };
}

/** OpenRouter's `/models?category=` values. */
export type Category =
  | 'programming' | 'marketing' | 'marketing/seo' | 'technology' | 'science'
  | 'translation' | 'legal' | 'finance' | 'health' | 'trivia' | 'academia';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'programming', label: 'Programming' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'marketing/seo', label: 'SEO' },
  { id: 'technology', label: 'Technology' },
  { id: 'science', label: 'Science' },
  { id: 'translation', label: 'Translation' },
  { id: 'legal', label: 'Legal' },
  { id: 'finance', label: 'Finance' },
  { id: 'health', label: 'Health' },
  { id: 'trivia', label: 'Trivia' },
  { id: 'academia', label: 'Academia' },
];

export interface CatalogResponse {
  models: CatalogModel[];
  /** Model ids per category, in OpenRouter's order; categories that failed to load are absent. */
  rankings: Partial<Record<Category, string[]>>;
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
  /** e.g. ['text', 'image', 'file']; ['text'] when unknown. */
  inputModalities: string[];
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
  memoryModelId: string;
}

export type SettingsUpdate = Partial<{
  apiKey: string;
  aboutMe: string;
  customInstructions: string;
  theme: Theme;
  defaultModelId: string;
  titleModelId: string;
  memoryModelId: string;
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
export interface StreamReasoning { text: string }
export interface StreamDone { message: Message }
export interface StreamError { message: string; partial: Message | null }
export interface StreamTitle { title: string }

// Server-sent events emitted when a generation endpoint is called with `modelIds` (a comparison)
export interface CompareSlot { assistantMessageId: string; modelId: string }
export interface CompareStart { userMessageId: string | null; slots: CompareSlot[] }
export interface CompareSlotText { slot: number; text: string }
export interface CompareSlotDone { slot: number; message: Message }
export interface CompareSlotError { slot: number; message: string; partial: Message | null }
export interface CompareDone { compareParentId: string | null }
