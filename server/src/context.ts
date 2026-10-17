import { imageSkippedNote } from '../../shared/attachments';
import type { ContextParts, ContextUsage, Message } from '../../shared/types';

// OpenRouter reports one prompt total per reply, so the split is estimated by counting each part ourselves and
// scaling the counts to that total. A real tokenizer wouldn't buy much: the scaling absorbs most of the error.

const CHARS_PER_TOKEN = 4;
/** Typical cost of one image for vision models (varies with size and provider). */
export const IMAGE_TOKENS = 1_000;
/** Typical cost of one PDF page once it has been turned into text. */
export const PDF_PAGE_TOKENS = 1_000;

export const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Counts page objects; PDFs that hide them in compressed streams count as one page. */
export function pdfPages(data: Buffer): number {
  return Math.max(1, data.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0);
}

export interface ContextInput {
  modelId: string;
  contextLength: number | null;
  system: string | null;
  /** The chat's active path, oldest first; [] for a chat that hasn't started. */
  path: Message[];
  canViewImages: boolean;
  loadData(id: string): Buffer;
}

const zero = (): ContextParts => ({ system: 0, user: 0, assistant: 0, attachments: 0, search: 0 });
const total = (p: ContextParts) => p.system + p.user + p.assistant + p.attachments + p.search;

function addMessage(parts: ContextParts, m: Message, o: ContextInput): void {
  parts[m.role] += textTokens(m.content);
  for (const a of m.attachments) {
    if (a.kind === 'text') parts.attachments += textTokens(o.loadData(a.id).toString('utf8'));
    else if (a.kind === 'pdf') parts.attachments += pdfPages(o.loadData(a.id)) * PDF_PAGE_TOKENS;
    else parts.attachments += o.canViewImages ? IMAGE_TOKENS : textTokens(imageSkippedNote(a.filename));
  }
}

/** Scales the estimated parts to `target`, putting the rounding remainder on the largest part so they sum exactly. */
function scaleTo(parts: ContextParts, target: number): ContextParts {
  const sum = total(parts);
  if (sum === 0) return { ...zero(), user: target };
  const keys = Object.keys(parts) as (keyof ContextParts)[];
  const out = zero();
  for (const k of keys) out[k] = Math.round((parts[k] * target) / sum);
  const largest = keys.reduce((a, b) => (out[b] > out[a] ? b : a));
  out[largest] += target - total(out);
  return out;
}

/**
 * What the window held at the end of the latest reply that reported usage (its prompt plus its reply), with
 * anything after it (e.g. a message whose reply was stopped) estimated. Search results only stay in the window for
 * the reply that ran the search, so they come from that reply's prompt total minus everything else.
 */
export function estimateContext(o: ContextInput): ContextUsage {
  const anchorIndex = o.path.findLastIndex((m) => m.role === 'assistant' && m.promptTokens !== null);
  const base = { modelId: o.modelId, contextLength: o.contextLength };
  const before = zero();
  before.system = o.system ? textTokens(o.system) : 0;

  if (anchorIndex === -1) {
    for (const m of o.path) addMessage(before, m, o);
    return { ...base, used: total(before), estimated: true, parts: before };
  }

  const anchor = o.path[anchorIndex];
  for (const m of o.path.slice(0, anchorIndex)) addMessage(before, m, o);
  const prompt = anchor.promptTokens!;
  const searched = (anchor.webSearches ?? 0) > 0 || anchor.sources.length > 0;
  const estimate = total(before);
  const parts = searched && estimate <= prompt ? { ...before, search: prompt - estimate } : scaleTo(before, prompt);

  parts.assistant += anchor.completionTokens ?? textTokens(anchor.content);
  for (const m of o.path.slice(anchorIndex + 1)) addMessage(parts, m, o);
  return { ...base, used: total(parts), estimated: false, parts };
}
