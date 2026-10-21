import { parseSSE } from '../../../shared/sse';
import type { Source } from '../../../shared/types';
import type { StreamEvent, Usage } from '../openrouter';

const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** Streamed `url_citation` annotations as sources; anything that isn't an http(s) link is dropped, as are snippets. */
export function toSources(annotations: unknown): Source[] {
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((a) => {
    const cite = a?.type === 'url_citation' ? a.url_citation : undefined;
    if (typeof cite?.url !== 'string' || !isWebUrl(cite.url)) return [];
    return [{ url: cite.url, title: typeof cite.title === 'string' ? cite.title : '' }];
  });
}

/**
 * Reads an OpenAI-style chat completion stream (OpenRouter, LM Studio, other compatible servers) into events.
 * `onError` turns an error chunk into the caller's own error type.
 */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
  onError: (status: number, message: string) => never,
  parseUsage: (raw: any) => Usage,
): AsyncGenerator<StreamEvent> {
  // Function calls stream in pieces by index: the name once, the arguments as text fragments.
  const calls: { name: string; arguments: string }[] = [];
  const finishedCalls = function* (): Generator<StreamEvent> {
    for (const call of calls) if (call?.name) yield { type: 'tool_call', name: call.name, arguments: call.arguments };
  };
  for await (const { data } of parseSSE(body)) {
    if (data === '[DONE]') {
      yield* finishedCalls();
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      const status = Number(chunk.error.code) || 502;
      onError(status, chunk.error.message);
    }
    const delta = chunk.choices?.[0]?.delta;
    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoning) yield { type: 'reasoning', text: reasoning };
    if (delta?.content) yield { type: 'delta', text: delta.content };
    if (delta?.annotations) {
      const sources = toSources(delta.annotations);
      if (sources.length) yield { type: 'sources', sources };
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const part of delta.tool_calls) {
        const i = typeof part?.index === 'number' ? part.index : 0;
        calls[i] ??= { name: '', arguments: '' };
        if (typeof part.function?.name === 'string') calls[i].name += part.function.name;
        if (typeof part.function?.arguments === 'string') calls[i].arguments += part.function.arguments;
      }
    }
    if (chunk.usage) yield { type: 'usage', usage: parseUsage(chunk.usage) };
  }
  yield* finishedCalls();
}
