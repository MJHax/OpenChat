import type { SavedPrompt } from '../../../shared/types';

// `{{name}}`: letters, digits, `_`, `-` and spaces. Anything else in double braces ({{ user.name }}, {{{x}}}) is left as text.
const SLOT = /(?<!\{)\{\{\s*([A-Za-z0-9_\- ]*[A-Za-z0-9_\-][A-Za-z0-9_\- ]*)\s*\}\}(?!\})/g;

/** The prompt's slot names, each once, in the order they first appear. */
export function promptSlots(content: string): string[] {
  return [...new Set([...content.matchAll(SLOT)].map((m) => m[1].trim()))];
}

/** The prompt with its slots filled in; a slot with no value stays as written, so it's easy to spot. */
export function fillSlots(content: string, values: Record<string, string>): string {
  return content.replace(SLOT, (whole, name: string) => slotValue(values, name.trim()) || whole);
}

/** A slot's value; only the user's own entries count, never inherited keys like `constructor`. */
export function slotValue(values: Record<string, string>, name: string): string {
  return Object.hasOwn(values, name) ? values[name] : '';
}

/** Puts `text` into `value` at the caret on a line of its own; the returned caret sits right after it. */
export function insertOnOwnLine(value: string, caret: number, text: string): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, at);
  const after = value.slice(at);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const trail = after && !after.startsWith('\n') ? '\n' : '';
  return { value: before + lead + text + trail + after, caret: before.length + lead.length + text.length };
}

/** The name a prompt goes by in the list: its title, or else its first line. */
export function promptLabel(p: SavedPrompt): string {
  if (p.title) return p.title;
  return (p.content.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 60);
}

export function matchesPrompt(p: SavedPrompt, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
}
