import { canViewImages, imageSkippedNote } from '../../shared/attachments';
import { collapseSuperseded } from '../../shared/files';
import type { Attachment, Message } from '../../shared/types';

export interface Persona {
  aboutMe: string;
  customInstructions: string;
  memories: string[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** OpenRouter's PDF handling; OpenChat always names the engine so the paid OCR default never runs by surprise. */
export type Plugin = { id: 'file-parser'; pdf: { engine: 'native' | 'cloudflare-ai' } };

type PathEntry = Pick<Message, 'role' | 'content'> & { attachments?: Attachment[] };

export interface AttachmentOptions {
  /** What the model replying accepts, e.g. ['text', 'image']. */
  inputModalities: string[];
  loadData(id: string): Buffer;
}

export function buildSystemPrompt(p: Persona): string | null {
  const sections: string[] = [];
  if (p.aboutMe.trim()) sections.push(`About the user:\n${p.aboutMe.trim()}`);
  if (p.customInstructions.trim()) sections.push(`Instructions:\n${p.customInstructions.trim()}`);
  const memories = p.memories.map((m) => m.trim()).filter(Boolean);
  if (memories.length) sections.push(`Things to remember about the user:\n${memories.map((m) => `- ${m}`).join('\n')}`);
  return sections.length ? sections.join('\n\n') : null;
}

export const FILE_INSTRUCTIONS_HEADER = 'Files:';

/** How a reply hands the user a file. Only reply prompts get it; titles and memory suggestions never make files. */
export function fileInstructions(imageNames: string[]): string {
  const lines = [
    FILE_INSTRUCTIONS_HEADER,
    'When the user asks for a file, or the answer is a standalone document they will want to view or keep (a web page, SVG, CSV, long Markdown, a script), put it in a file block:',
    '<file name="short-name.ext">',
    '…raw content, no code fence…',
    '</file>',
    'The tags go on their own lines. To change a file, write the whole file again under the same name. Mention it in a sentence; do not repeat its content outside the block.',
    'HTML must be one self-contained file; it may load libraries from public CDNs. For pages meant to print or save as PDF, use print CSS (@page size, page breaks).',
  ];
  if (imageNames.length) lines.push(`Images attached in this chat can be used in HTML by name (src="name"): ${imageNames.join(', ')}.`);
  return lines.join('\n');
}

/** The system prompt for a reply: the persona, if any, then the file section. */
export function replySystemPrompt(p: Persona, imageNames: string[]): string {
  const persona = buildSystemPrompt(p);
  const files = fileInstructions(imageNames);
  return persona ? `${persona}\n\n${files}` : files;
}

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const dataUrl = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString('base64')}`;

/** Text first, then text files, images and PDFs, each group in attachment order. */
function toParts(m: PathEntry, attachments: Attachment[], o: AttachmentOptions): ContentPart[] {
  const parts: ContentPart[] = m.content ? [{ type: 'text', text: m.content }] : [];
  const ofKind = (kind: Attachment['kind']) => attachments.filter((a) => a.kind === kind);
  for (const a of ofKind('text')) {
    parts.push({ type: 'text', text: `<file name="${attr(a.filename)}">\n${o.loadData(a.id).toString('utf8')}\n</file>` });
  }
  const images = canViewImages(o.inputModalities);
  for (const a of ofKind('image')) {
    parts.push(images ? { type: 'image_url', image_url: { url: dataUrl(a.mime, o.loadData(a.id)) } } : { type: 'text', text: imageSkippedNote(a.filename) });
  }
  for (const a of ofKind('pdf')) {
    parts.push({ type: 'file', file: { filename: a.filename, file_data: dataUrl(a.mime, o.loadData(a.id)) } });
  }
  return parts;
}

/**
 * Messages without attachments stay plain strings, so prompts for plain chats are unchanged. With `files` (replies),
 * the system prompt explains file blocks and only the latest version of each file is sent in full.
 */
export function buildMessages(p: Persona, path: PathEntry[], o?: AttachmentOptions, files?: { imageNames: string[] }): ChatMessage[] {
  const system = files ? replySystemPrompt(p, files.imageNames) : buildSystemPrompt(p);
  const contents = files ? collapseSuperseded(path) : path.map((m) => m.content);
  const messages: ChatMessage[] = path.map((entry, i) => {
    const m = { ...entry, content: contents[i] };
    const attachments = m.attachments ?? [];
    if (!o || attachments.length === 0) return { role: m.role, content: m.content };
    return { role: m.role, content: toParts(m, attachments, o) };
  });
  return system ? [{ role: 'system', content: system }, ...messages] : messages;
}

export function pdfPlugins(path: { attachments?: Attachment[] }[], inputModalities: string[]): Plugin[] | undefined {
  if (!path.some((m) => m.attachments?.some((a) => a.kind === 'pdf'))) return undefined;
  return [{ id: 'file-parser', pdf: { engine: inputModalities.includes('file') ? 'native' : 'cloudflare-ai' } }];
}
