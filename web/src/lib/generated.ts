import { ATTACHMENT_LIMITS } from '../../../shared/attachments';
import type { GeneratedItems } from '../../../shared/types';

/** The picker's search: thread and chat titles, and file names. */
export function filterGenerated(items: GeneratedItems, query: string): GeneratedItems {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return {
    images: items.images.filter((i) => i.threadTitle.toLowerCase().includes(q)),
    files: items.files.filter((f) => `${f.chatTitle} ${f.name}`.toLowerCase().includes(q)),
  };
}

/** A generated image too big to attach as it is; the browser shrinks it first. */
export const needsShrinking = (bytes: number): boolean => bytes > ATTACHMENT_LIMITS.image;
