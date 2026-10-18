import type { ImageModel, ImageSettings } from './imageModels';
import type { VideoModel } from './videoModels';

export type MediaModel = ImageModel | VideoModel;

export type Role = 'user' | 'assistant';
/** 'generating' and 'error' only occur in image and video threads. */
export type MessageStatus = 'complete' | 'stopped' | 'generating' | 'error';
/** What a thread is for: a conversation, or making images or videos. */
export type ThreadKind = 'chat' | 'image' | 'video';
export type Theme = 'light' | 'dark' | 'system';
export type AttachmentKind = 'image' | 'pdf' | 'text';

/** A file attached to a user message (metadata only; the bytes are served by /api/attachments/:id). */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
}

/** A web page a reply's search drew on. */
export interface Source {
  url: string;
  title: string;
}

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
  /** Files attached to a user message, in order; [] for assistant messages and plain text. */
  attachments: Attachment[];
  /** User messages: whether web search was on when sent. Always false for assistant messages. */
  webSearch: boolean;
  /** Assistant messages: pages the reply's searches drew on, deduplicated by URL; [] otherwise. */
  sources: Source[];
  /** Assistant messages: how many searches ran, when known. */
  webSearches: number | null;
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
  /** Replies and titles, plus image and video generations. */
  totalCost: number;
  kind: ThreadKind;
  /** Image threads: the latest generated image, for the sidebar. */
  thumbnailId: string | null;
  /** Image and video threads: a generation is still running. */
  busy: boolean;
}

export type MediaKind = 'image' | 'video';

/** An image (or video) model in the user's list, with its catalog details when cached. */
export interface MediaLibraryModel {
  id: string;
  displayName: string;
  kind: MediaKind;
  /** ImageModel for kind 'image', VideoModel for kind 'video'; null when the catalog no longer lists it. */
  model: MediaModel | null;
  /** Average time to generate, from completed calls; null before the first. */
  avgRenderMs: number | null;
  /** The last 20 completed render times, newest first, for "usually N–M min". */
  recentRenderMs: number[];
  /** The user's own average cost, keyed "size|quality" (e.g. "1K|medium", "2K|"). */
  avgCost: Record<string, number>;
}

export interface MediaCatalog {
  models: MediaModel[];
  fetchedAt: number;
  stale: boolean;
}

export interface ChatDetail {
  chat: Omit<ChatSummary, 'thumbnailId' | 'busy'> & {
    activeLeafId: string | null;
    /** This chat's own instructions, sent after the global custom instructions; '' when none. */
    instructions: string;
  };
  messages: PathMessage[];
  /** Set while a comparison's replies are waiting for the user to pick one. */
  compare: { parentId: string; replies: Message[] } | null;
  /** Images attached anywhere in the chat, newest first, one per file name; generated pages can show them by name. */
  chatImages: Attachment[];
  /** Image and video threads: the request behind each assistant message, by message id. */
  generations: Record<string, ImageGeneration>;
}

export interface ImageGeneration {
  modelId: string;
  prompt: string;
  /** ImageSettings in image threads, VideoSettings in video threads. */
  settings: ImageSettings;
  /** Video threads: the start and end photo attachment ids. */
  frames?: { start: string | null; end: string | null };
  /** Video threads: OpenRouter's job status while rendering. */
  jobStatus?: string | null;
  /** Video threads: why the last check on a rendering clip failed (it keeps trying). */
  jobError?: string | null;
  /** 'new' image, an edit of a generated one, or an edit of an uploaded photo. */
  mode: 'new' | 'edit_generated' | 'edit_upload';
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  targetAttachmentId: string | null;
  cost: number | null;
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
  /** USD per cached prompt token read; null if unknown. */
  cacheReadPrice: number | null;
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
    cacheReadPrice: null,
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
  /** Which mode the thread opens in. */
  chatKind: ThreadKind;
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

/** Time range the Stats page shows. */
export type StatsRange = 'all' | 'year' | 'month' | 'week' | 'today';

export interface StatsTiles {
  cost: number;
  /** Cost of the previous period of the same length; null for All time. */
  previousCost: number | null;
  promptTokens: number;
  completionTokens: number;
  replies: number;
  /** Chats with a reply in the range, including deleted ones. */
  chats: number;
  cacheHitRate: number | null;
  cacheSavings: number | null;
  webSearches: number;
  webSearchCost: number;
  avgFirstTokenMs: number | null;
  outputTokensPerSec: number | null;
  activeDays: number;
  rangeDays: number | null;
  currentStreak: number;
  longestStreak: number;
  topModel: { id: string; name: string; share: number } | null;
}

export interface HeatDay { day: string; replies: number; cost: number }

export interface UsageBucket {
  key: string;
  label: string;
  replyCost: number;
  backgroundCost: number;
  replyTokens: number;
  backgroundTokens: number;
  replies: number;
  backgroundCalls: number;
}

export interface ModelStats {
  id: string;
  name: string;
  replies: number;
  cost: number;
  tokens: number;
  cacheHitRate: number | null;
  avgFirstTokenMs: number | null;
  outputTokensPerSec: number | null;
  avgCostPerReply: number | null;
  reasoningTokens: number | null;
  errorRate: number | null;
  stoppedRate: number | null;
  webSearches: number;
}

export interface FeatureStats {
  compareRuns: number;
  webSearchReplies: number;
  attachments: number;
  regeneratedOrEdited: number;
  inputOutputRatio: number | null;
}

export interface BigChat { id: string; title: string; cost: number; replies: number }

export interface StatsResponse {
  range: StatsRange;
  tiles: StatsTiles;
  heatmap: HeatDay[];
  buckets: UsageBucket[];
  models: ModelStats[];
  features: FeatureStats;
  biggestByCost: BigChat[];
  biggestByLength: BigChat[];
  /** When cache, speed, error and feature tracking began (first non-backfilled call); null if never. */
  trackingSince: number | null;
  /** Everything OpenChat spent in the range, chats, images and videos together: matches the OpenRouter bill. */
  allSpend: number;
}

/** The Images (or Video) view of the Stats page. */
export interface MediaStatsResponse {
  range: StatsRange;
  tiles: {
    /** Images or clips made (failures not included). */
    count: number;
    /** Generations plus title calls for these threads. */
    spend: number;
    avgCost: number | null;
    avgDurationMs: number | null;
    /** Only models that report tokens count here; `tokenModels` says how many did. */
    promptTokens: number;
    completionTokens: number;
    tokenModels: number;
    failures: number;
    /** Video only. */
    seconds?: number;
    avgCostPerSecond?: number | null;
  };
  heatmap: HeatDay[];
  buckets: { key: string; label: string; count: number; cost: number }[];
  models: {
    id: string; name: string; count: number; spend: number; avgCost: number | null; avgDurationMs: number | null;
    promptTokens: number | null; completionTokens: number | null; failures: number; seconds?: number;
  }[];
  /** Images only: fresh images, edits of generated ones, edits of uploaded photos. */
  modes: { new: number; editGenerated: number; editUpload: number } | null;
  /** Everything OpenChat spent in the range, every kind: matches the OpenRouter bill. */
  allSpend: number;
}

/** Things OpenChat made that a chat can attach: images from image threads, and each chat's latest generated files. */
export interface GeneratedItems {
  images: { attachmentId: string; threadId: string; threadTitle: string; createdAt: number }[];
  files: { chatId: string; chatTitle: string; messageId: string; name: string; size: number }[];
}

export interface MediaThreadStats {
  count: number;
  spend: number;
  avgCost: number | null;
  avgDurationMs: number | null;
  failures: number;
}

export interface ChatStats {
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitRate: number | null;
  cacheSavings: number | null;
  replies: number;
  models: number;
  webSearches: number;
  avgPromptTokens: number | null;
}

/** Roughly how many tokens each part of the conversation takes up in the model's context window. */
export interface ContextParts {
  system: number;
  user: number;
  assistant: number;
  attachments: number;
  /** Search results pulled into the latest reply; 0 when it didn't search. */
  search: number;
}

export interface ContextUsage {
  modelId: string;
  /** The model's window in tokens; null when OpenRouter doesn't say. */
  contextLength: number | null;
  /** The real total from the latest reply's usage, plus estimates for anything after it. */
  used: number;
  /** True when no reply has reported its usage yet, so `used` is only an estimate. */
  estimated: boolean;
  /** Sums to `used`. Always approximate: OpenRouter reports one total, not a split. */
  parts: ContextParts;
}
