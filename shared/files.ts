/** A file a model wrote into its reply as `<file name="…">` … `</file>`. */
export interface FileBlock {
  name: string;
  content: string;
  /** False when the closing tag never came: still streaming, or the reply was cut off. */
  complete: boolean;
}

export type Segment = { type: 'text'; text: string } | { type: 'file'; file: FileBlock };

const OPEN = /^\s*<file\s+name="([^"]*)"\s*>\s*$/;
const FENCE_OPEN = /^\s*```[\w+-]*\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

interface Line { start: number; end: number; next: number; text: string }

/** Lines with their offsets: `end` excludes the line break, `next` is where the following line starts. */
function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const next = nl === -1 ? text.length : nl + 1;
    const end = nl === -1 ? text.length : nl > start && text[nl - 1] === '\r' ? nl - 1 : nl;
    out.push({ start, end, next, text: text.slice(start, end) });
    start = next;
  }
  return out;
}

/** Drops one trailing line break, which belongs to the line the closing tag sits on. */
const trimBreak = (s: string) => s.replace(/\r?\n$/, '');

/**
 * Splits an assistant message into text and files. An opening tag must be a line of its own and only a line that is
 * exactly `</file>` closes it; one code fence wrapped around a whole block is dropped.
 */
export function parseFileBlocks(text: string): Segment[] {
  const ls = lines(text);
  const segments: Segment[] = [];
  let textStart = 0;
  const pushText = (end: number) => {
    if (end > textStart) segments.push({ type: 'text', text: text.slice(textStart, end) });
  };

  for (let i = 0; i < ls.length; i++) {
    const open = OPEN.exec(ls[i].text);
    if (!open) continue;
    const fenced = i > 0 && ls[i - 1].start >= textStart && FENCE_OPEN.test(ls[i - 1].text);
    pushText(fenced ? ls[i - 1].start : ls[i].start);
    const name = decode(open[1]);
    const contentStart = ls[i].next;
    const close = ls.findIndex((l, j) => j > i && l.text.trim() === '</file>');
    if (close === -1) {
      segments.push({ type: 'file', file: { name, content: trimBreak(text.slice(contentStart)), complete: false } });
      return segments;
    }
    const content = close === i + 1 ? '' : trimBreak(text.slice(contentStart, ls[close].start));
    segments.push({ type: 'file', file: { name, content, complete: true } });
    textStart = ls[close].end;
    if (fenced && close + 1 < ls.length && FENCE_CLOSE.test(ls[close + 1].text)) textStart = ls[close + 1].end;
    i = close;
  }
  pushText(text.length);
  return segments;
}

/** Rewrites every file block (tags included) to `fn`'s result, leaving the text around it as it was. */
export function mapFileBlocks(text: string, fn: (file: FileBlock) => string): string {
  return parseFileBlocks(text).map((s) => (s.type === 'text' ? s.text : fn(s.file))).join('');
}

export type FileKind = 'html' | 'svg' | 'md' | 'csv' | 'code' | 'other';

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'json', 'css', 'sh', 'sql', 'yaml', 'yml', 'xml', 'java', 'c', 'cpp', 'h', 'go', 'rs',
  'rb', 'php', 'txt', 'toml', 'ini', 'kt', 'swift', 'cs',
]);

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export function fileKind(name: string): FileKind {
  const ext = extension(name);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'csv') return 'csv';
  return CODE_EXTENSIONS.has(ext) ? 'code' : 'other';
}

export function mimeFor(name: string): string {
  const ext = extension(name);
  if (ext === 'svg') return 'image/svg+xml';
  const base: Record<string, string> = {
    html: 'text/html', htm: 'text/html', csv: 'text/csv', json: 'application/json', md: 'text/markdown', markdown: 'text/markdown',
  };
  return `${base[ext] ?? 'text/plain'};charset=utf-8`;
}

/** The last path segment, with characters Windows and macOS refuse replaced; never empty. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file.txt';
}
