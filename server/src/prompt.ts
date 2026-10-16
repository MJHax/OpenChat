import { canViewImages, imageSkippedNote } from '../../shared/attachments';
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

const dataUrl = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString('base64')}`;

/** Text first, then text files, images and PDFs, each group in attachment order. */
function toParts(m: PathEntry, attachments: Attachment[], o: AttachmentOptions): ContentPart[] {
  const parts: ContentPart[] = m.content ? [{ type: 'text', text: m.content }] : [];
  const ofKind = (kind: Attachment['kind']) => attachments.filter((a) => a.kind === kind);
  for (const a of ofKind('text')) {
    parts.push({ type: 'text', text: `<file name="${a.filename}">\n${o.loadData(a.id).toString('utf8')}\n</file>` });
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

/** Messages without attachments stay plain strings, so prompts for plain chats are unchanged. */
export function buildMessages(p: Persona, path: PathEntry[], o?: AttachmentOptions): ChatMessage[] {
  const system = buildSystemPrompt(p);
  const messages: ChatMessage[] = path.map((m) => {
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
