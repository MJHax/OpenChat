import { createContext } from 'react';
import type { FileBlock } from '../../../shared/files';

/** What a file card (or a code block's "Save as file") can ask of the chat's side panel. */
export interface FilePanelApi {
  /** Opens `file` in the panel; `messageId` is the reply it came from, null while streaming or for a snippet. */
  open(name: string, messageId: string | null, file: FileBlock): void;
  /** The file's version number on the active path (1-based), or null when it has none yet. */
  versionOf(name: string, messageId: string | null): number | null;
  /** Saves the file; HTML gets the chat's images inlined so the download is self-contained. */
  download(file: FileBlock): void;
}

/** Null outside a chat: cards still render, they just can't open a panel. */
export const FilePanelContext = createContext<FilePanelApi | null>(null);
