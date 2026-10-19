import type { AttachmentKind, LibraryFileType } from './types';

const DOC_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'rtf', 'csv', 'tsv', 'html', 'htm', 'log']);

/** Which Library filter a stored file falls under; text files are Docs or Code by extension. */
export function libraryType(kind: AttachmentKind, name: string): Exclude<LibraryFileType, 'video'> {
  if (kind === 'image') return 'image';
  if (kind === 'pdf') return 'doc';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return DOC_EXTENSIONS.has(ext) ? 'doc' : 'code';
}
