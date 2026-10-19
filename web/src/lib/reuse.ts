import type { Attachment, LibraryItem } from '../../../shared/types';
import { api, librarySrc } from '../api';
import { needsShrinking } from './generated';
import { shrinkImage } from './shrinkImage';

export interface ReuseDraft { attachments: Attachment[]; files: File[] }

/**
 * A Library file ready to drop into a new chat's composer: a pending copy on the server, or (for an image too big
 * to attach as it is) a shrunk file the composer uploads like any other.
 */
export async function reuseItem(item: LibraryItem): Promise<ReuseDraft> {
  const { source } = item;
  if (source.type === 'video') throw new Error("Videos can't be attached to a chat.");
  if (source.type === 'chatFile') return { attachments: [await api.copyGenerated({ messageId: source.messageId, name: source.name })], files: [] };
  if (source.kind === 'image' && needsShrinking(item.size)) {
    const blob = await (await fetch(librarySrc(source))).blob();
    const base = item.name.replace(/\.[^.]+$/, '') || 'image';
    return { attachments: [], files: [new File([await shrinkImage(blob)], `${base}.jpg`, { type: 'image/jpeg' })] };
  }
  return { attachments: [await api.copyGenerated({ attachmentId: source.attachmentId })], files: [] };
}
