import type { FileBlock, FileVersion } from '../../../shared/files';

export interface OpenFile {
  name: string;
  /** The reply the file was opened from; null for a snippet. */
  messageId: string | null;
  /** A file with no versions (a code block saved as a file). */
  adhoc: FileBlock | null;
}

/**
 * What the panel shows for `open`, given the file's versions on the current path; null when the reply it was opened
 * from has left the path (regenerated, edited away, another sibling picked), so the panel closes instead of going blank
 * or silently showing a different reply's file.
 */
export function panelView(open: OpenFile, versions: FileVersion[]): { versions: FileVersion[]; initial: number } | null {
  if (open.adhoc) return { versions: [], initial: 1 };
  const opened = versions.find((v) => v.messageId === open.messageId);
  return opened ? { versions, initial: opened.version } : null;
}

/** A file still being written can't be opened yet: the panel would show a frozen, partial copy. */
export const cardOpenable = (file: FileBlock, streaming: boolean): boolean => file.complete || !streaming;
