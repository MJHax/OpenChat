import type { ContextOverflow } from '../../../shared/types';

/** The overflow prompt's question: "A", "A and B" or "A, B and C" can't remember the chat. */
export function overflowTitle(overflow: ContextOverflow[]): string {
  const names = overflow.map((o) => o.displayName);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
  return `This chat is longer than ${joined} can remember.`;
}

/** What goes back into the message box when a "Send anyway" send fails before the server took it; null when there is no draft. */
export function draftAfterFailedSend<A>(opts: { kind: string; text?: string; attachments?: A[] }): { text: string; attachments: A[] } | null {
  return opts.kind === 'send' ? { text: opts.text ?? '', attachments: opts.attachments ?? [] } : null;
}
