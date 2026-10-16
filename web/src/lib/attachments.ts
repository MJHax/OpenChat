import {
  ATTACHMENT_LIMITS, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, TOO_MANY_FILES, TOO_MUCH_TOTAL, canViewImages, tooLargeMessage,
} from '../../../shared/attachments';
import type { Attachment, AttachmentKind, LibraryModel } from '../../../shared/types';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** A best guess for instant feedback; the server decides from the file's content. */
export function guessKind(file: { name: string; type: string }): AttachmentKind {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  return 'text';
}

/** Why `file` can't be added to a draft that already holds `existing`, or null if it can. */
export function addError(existing: { size: number }[], file: { name: string; size: number; type: string }): string | null {
  const kind = guessKind(file);
  if (file.size > ATTACHMENT_LIMITS[kind]) return tooLargeMessage(file.name, kind);
  if (existing.length >= MAX_ATTACHMENTS) return TOO_MANY_FILES;
  if (existing.reduce((sum, a) => sum + a.size, file.size) > MAX_TOTAL_BYTES) return TOO_MUCH_TOTAL;
  return null;
}

/** Why the draft can't be sent to `models` (the model or compare set that would reply), or null. */
export function sendBlockReason(kinds: AttachmentKind[], models: LibraryModel[]): string | null {
  if (!kinds.includes('image')) return null;
  const blind = models.filter((m) => !canViewImages(m.inputModalities));
  if (blind.length === 0) return null;
  if (models.length > 1) return "Some of the compare models can't view images. Remove the image or pick other models.";
  return `${blind[0].displayName} can't view images. Remove the image or pick another model.`;
}

/** A heads-up when images already in the chat will be replaced by a note for one of `models`. */
export function skippedImagesNotice(path: { attachments: Attachment[] }[], models: LibraryModel[]): string | null {
  if (!path.some((m) => m.attachments.some((a) => a.kind === 'image'))) return null;
  const blind = models.find((m) => !canViewImages(m.inputModalities));
  return blind ? `Images earlier in this chat will be skipped for ${blind.displayName}.` : null;
}
