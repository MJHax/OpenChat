import type { Attachment, LibraryItem } from '../../../shared/types';
import { api, librarySrc, uploadAttachment } from '../api';
import { needsShrinking } from './generated';
import { shrinkImage } from './shrinkImage';

/** What a new chat starts with; `text` (from a saved prompt) goes in the message box. */
export interface ReuseDraft { attachments: Attachment[]; files: File[]; text?: string }

/**
 * A Library file ready to drop into a new chat's composer, as a pending copy on the server. An image too big to
 * attach as it is gets shrunk here and uploaded as a copy of the original, so the Library still counts it as that file.
 */
export async function reuseItem(item: LibraryItem): Promise<ReuseDraft> {
  const { source } = item;
  if (source.type === 'video') throw new Error("Videos can't be attached to a chat.");
  if (source.type === 'chatFile') return { attachments: [await api.copyGenerated({ messageId: source.messageId, name: source.name })], files: [] };
  if (source.kind === 'image' && needsShrinking(item.size)) {
    const blob = await (await fetch(librarySrc(source))).blob();
    const base = item.name.replace(/\.[^.]+$/, '') || 'image';
    const file = new File([await shrinkImage(blob)], `${base}.jpg`, { type: 'image/jpeg' });
    return { attachments: [await uploadAttachment(file, () => {}, undefined, source.attachmentId)], files: [] };
  }
  return { attachments: [await api.copyGenerated({ attachmentId: source.attachmentId })], files: [] };
}
