import type { Attachment } from '../../../shared/types';

/** A generated SVG (vector) image. Library items carry only a name, which ends in .svg for these. */
export const isSvgAttachment = (a: Pick<Attachment, 'mime'>): boolean => a.mime === 'image/svg+xml';
export const isSvgName = (name: string): boolean => /\.svg$/i.test(name);
