import {
  ATTACHMENT_LIMITS, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, MB, TOO_MANY_FILES, TOO_MUCH_TOTAL, UNSUPPORTED_TYPE, canViewImages, tooLargeMessage,
} from '../../../shared/attachments';
import type { Attachment, AttachmentKind, LibraryModel } from '../../../shared/types';
import { isLocalModelId } from '../../../shared/localModels';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** A best guess for instant feedback; the server decides from the file's content. */
export function guessKind(file: { name: string; type: string }): AttachmentKind {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  return 'text';
}

/** Browsers report code files under all sorts of types (.ts is video/mp2t), so only these clearly mean text. */
const TEXT_SUBTYPES = ['json', 'xml', 'javascript', 'ecmascript', 'x-yaml', 'yaml', 'toml', 'sql', 'x-sh', 'x-python', 'x-httpd-php'];
const looksLikeText = (type: string): boolean => {
  if (type === '' || type.startsWith('text/')) return true;
  const subtype = type.split('/')[1] ?? '';
  return TEXT_SUBTYPES.includes(subtype) || subtype.endsWith('+json') || subtype.endsWith('+xml');
};

/** The largest upload of any kind; past it the server refuses before reading the file. */
const MAX_UPLOAD = Math.max(...Object.values(ATTACHMENT_LIMITS));

/** Why `file` can't be added to a draft that already holds `existing`, or null if it can. */
export function addError(existing: { size: number }[], file: { name: string; size: number; type: string }): string | null {
  const kind = guessKind(file);
  // Image formats other than PNG, JPEG, WebP and GIF (e.g. iPhone HEIC photos) are never readable.
  if (file.type.startsWith('image/') && kind !== 'image') return UNSUPPORTED_TYPE;
  if (kind !== 'text' || looksLikeText(file.type)) {
    if (file.size > ATTACHMENT_LIMITS[kind]) return tooLargeMessage(file.name, kind);
  } else if (file.size > MAX_UPLOAD) {
    // Might be text or might be unreadable; the server decides, so only stop uploads it would refuse outright.
    return `${file.name} is too large. The limit is ${MAX_UPLOAD / MB} MB.`;
  }
  if (existing.length >= MAX_ATTACHMENTS) return TOO_MANY_FILES;
  if (existing.reduce((sum, a) => sum + a.size, file.size) > MAX_TOTAL_BYTES) return TOO_MUCH_TOTAL;
  return null;
}

/** addError for each of `files` in turn, counting the ones accepted before it. */
export function addErrors(existing: { size: number }[], files: { name: string; size: number; type: string }[]): (string | null)[] {
  const counted = [...existing];
  return files.map((file) => {
    const error = addError(counted, file);
    if (!error) counted.push(file);
    return error;
  });
}

/** `restored` (a failed send's attachments) back at the front of the draft, without doubling any still in it. */
export function withRestored<T extends { attachment: { id: string } | null }>(current: T[], restored: T[]): T[] {
  const ids = new Set(restored.map((i) => i.attachment?.id));
  return [...restored, ...current.filter((i) => !i.attachment || !ids.has(i.attachment.id))];
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
