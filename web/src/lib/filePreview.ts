import { safeFileName } from '../../../shared/files';

/**
 * The policy every generated page runs under. The iframe already has a null origin; this keeps the page from talking
 * to OpenChat's API (or anything else) while still letting it load scripts, styles, fonts and images from CDNs.
 */
export const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  'font-src https: data:',
  'img-src https: data: blob:',
  'media-src https: data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
].join('; ');

/** Lets the panel's Print button print the page from outside the sandbox. */
export const PRINT_LISTENER = "<script>addEventListener('message',function(e){if(e.data==='openchat:print')print()})</script>";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Points `src="name"` and CSS `url(name)` at the chat image of that exact name, as a data URL. */
export function inlineImages(html: string, images: Map<string, string>): string {
  let out = html;
  for (const [name, url] of images) {
    const n = escapeRegExp(name);
    out = out
      .replace(new RegExp(`(src\\s*=\\s*)(["'])${n}\\2`, 'g'), (_m, pre: string, q: string) => `${pre}${q}${url}${q}`)
      .replace(new RegExp(`url\\(\\s*(["']?)${n}\\1\\s*\\)`, 'g'), (_m, q: string) => `url(${q}${url}${q})`);
  }
  return out;
}

/**
 * The page as the panel runs it: images inlined, then a head holding the CSP, link target and print hook placed before
 * anything the page wrote (after a leading doctype only), so no script runs before the policy and no markup can hide it.
 * The page's own <html> and <head> tags that follow are merged into it by the HTML parser.
 */
export function prepareHtml(html: string, images: Map<string, string>): string {
  const page = inlineImages(html, images);
  const inject = `<head><meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}"><base target="_blank">${PRINT_LISTENER}</head>`;
  const doctype = /^\s*<!doctype[^>]*>\s*/i.exec(page);
  const at = doctype ? doctype[0].length : 0;
  return page.slice(0, at) + inject + page.slice(at);
}

/**
 * An SVG as an image URL. Not a blob: URL, which has OpenChat's origin, so "Open image in new tab" would run the SVG's
 * scripts with access to the API; browsers refuse to open data: URLs as top-level pages.
 */
export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** CSV rows (quoted fields may hold commas, doubled quotes and newlines), at most `cap`, with how many were left out. */
export function csvRows(text: string, cap = 500): { rows: string[][]; more: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return { rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap) };
}

/** Long code blocks get a "Save as file" button. */
export const saveableCode = (code: string): boolean => code.replace(/\n$/, '').split('\n').length >= 20;

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx', python: 'py', py: 'py', html: 'html',
  xml: 'xml', css: 'css', json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', sql: 'sql', markdown: 'md', md: 'md',
  csv: 'csv', svg: 'svg', yaml: 'yaml', yml: 'yml', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', go: 'go', rust: 'rs',
  rs: 'rs', ruby: 'rb', php: 'php', toml: 'toml', kotlin: 'kt', swift: 'swift', csharp: 'cs', cs: 'cs', text: 'txt', txt: 'txt',
};

/** A file name for a code block, from its fence language. */
export const snippetName = (lang: string | undefined): string =>
  safeFileName(`snippet.${LANGUAGE_EXTENSIONS[lang?.toLowerCase() ?? ''] ?? 'txt'}`);
