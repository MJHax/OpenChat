import type { Effort } from '../../../shared/types';
import type { FunctionTool, StreamEvent, Usage, WebSearchMode } from '../openrouter';
import type { ChatMessage, Plugin } from '../prompt';

export class ProviderError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** A local server (Ollama, LM Studio, ...) that is unreachable or refused a request; status 0 means unreachable. */
export class LocalServerError extends ProviderError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'LocalServerError';
  }
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  plugins?: Plugin[];
  webSearch?: WebSearchMode;
  tools?: FunctionTool[];
  effort?: Effort;
  /** Local thinking models only: false turns thinking off; undefined leaves the model's default. */
  think?: boolean;
}

export interface CompleteRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  onUsage?: (u: Usage) => void;
}

export interface ChatProvider {
  streamChat(o: ChatRequest): AsyncGenerator<StreamEvent>;
  complete(o: CompleteRequest): Promise<string>;
}

export interface LocalModelInfo {
  name: string;
  sizeBytes: number | null;
  contextLength: number | null;
  inputModalities: string[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  capsKnown: boolean;
}

export interface LocalClient extends ChatProvider {
  /** 1,500 ms timeout. */
  listModels(): Promise<LocalModelInfo[]>;
  /** `contextWindow` is the window to run the model with. */
  streamChat(o: ChatRequest & { contextWindow?: number }): AsyncGenerator<StreamEvent>;
  complete(o: CompleteRequest & { contextWindow?: number }): Promise<string>;
}
