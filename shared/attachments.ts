import type { AttachmentKind } from './types';

export const MB = 1024 * 1024;

/** Largest file accepted per kind. */
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = { image: 5 * MB, pdf: 20 * MB, text: 1 * MB };
export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_BYTES = 30 * MB;
/** Uploads never sent (e.g. the tab was closed) are deleted after this long. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const KIND_LABEL: Record<AttachmentKind, string> = { image: 'image', pdf: 'PDF', text: 'text' };

export const UNSUPPORTED_TYPE = "OpenChat can't read this file type yet. Images, PDFs and text files work.";
export const BAD_ATTACHMENT = 'One of the attachments is no longer available. Remove it and attach it again.';
export const TOO_MANY_FILES = `You can attach up to ${MAX_ATTACHMENTS} files.`;
export const TOO_MUCH_TOTAL = 'These files add up to more than 30 MB. Remove some and try again.';

export const tooLargeMessage = (name: string, kind: AttachmentKind): string =>
  `${name} is too large. The limit for ${KIND_LABEL[kind]} files is ${ATTACHMENT_LIMITS[kind] / MB} MB.`;

export const emptyFileMessage = (name: string): string => `${name} is empty.`;

/** Stands in for an image in the prompt of a model that can't view images. */
export const imageSkippedNote = (filename: string): string =>
  `[Image "${filename}" was attached here, but this model can't view images.]`;

export const canViewImages = (inputModalities: string[]): boolean => inputModalities.includes('image');
