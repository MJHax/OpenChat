import { createReadStream, existsSync, statSync } from 'node:fs';
import type { Deps } from './app';
import { getAttachmentData } from './attachments';
import type { ChatRow } from './chats';
import { getChatMessages } from './messages';
import { activePath } from './tree';
import { clipPath } from './videoJobs';
import type { ZipEntry } from './zip';
import { getDiscussionDetail } from './discussion/store';
import type { DiscussionDetail, Message, ThreadKind } from '../../shared/types';

const ROOT = 'openchat-export';
const FOLDER: Record<ThreadKind, string> = { chat: 'chats', image: 'images', video: 'videos', discussion: 'discussions' };

/** A file name that is safe on Windows, macOS and Linux; never empty. */
export function safeName(name: string, max = 60): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').slice(0, max).replace(/^[\s.-]+|[\s.-]+$/g, '');
  return clean || 'untitled';
}

const attachmentPath = (id: string, filename: string) => `attachments/${id}/${safeName(filename, 100)}`;
const threadPath = (chat: Pick<ChatRow, 'id' | 'kind' | 'title'>) => `${FOLDER[chat.kind]}/${safeName(chat.title)}-${chat.id.slice(0, 8)}.md`;
const when = (ts: number) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** One thread as Markdown: the conversation as it is shown (the active branch), with links to its files. */
export function threadMarkdown(chat: ChatRow, all: Message[], hasClip: (messageId: string) => boolean): string {
  const path = activePath(all, chat.active_leaf_id);
  const lines = [`# ${chat.title}`, '', `Exported from OpenChat. Started ${when(chat.created_at)}.`];
  if (all.length > path.length) lines.push('', `${all.length - path.length} message(s) on other branches are in data.json.`);
  for (const m of path) {
    const who = m.role === 'user' ? 'You' : `Assistant${m.modelId ? ` (${m.modelId})` : ''}`;
    lines.push('', '---', '', `**${who}** · ${when(m.createdAt)}`, '');
    if (m.content) lines.push(m.content, '');
    for (const a of m.attachments) {
      const link = `../${encode(attachmentPath(a.id, a.filename))}`;
      lines.push(a.kind === 'image' ? `![${a.filename}](${link})` : `Attached: [${a.filename}](${link})`);
    }
    if (chat.kind === 'video' && m.role === 'assistant' && hasClip(m.id)) lines.push(`[Video clip](../clips/${m.id}.mp4)`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** One discussion as Markdown: who said what, in order, then the summary if there is one. */
export function discussionMarkdown(d: DiscussionDetail): string {
  const lines = [`# ${d.chat.title}`, '', `Exported from OpenChat. Topic: "${d.topic}".`, '', '## Participants', ''];
  for (const p of d.participants) lines.push(`- **${p.name}**${p.isModerator ? ' (moderator)' : ''}: ${p.modelId}`);
  lines.push('', '## Transcript');
  for (const m of d.messages) {
    const who = d.participants.find((p) => p.id === m.participantId);
    const handoff = d.participants.find((p) => p.id === m.handoffTo);
    if (who && !m.content.trim()) {
      if (handoff) lines.push('', `_${who.name} passed the floor to ${handoff.name}._`);
      continue;
    }
    lines.push('', who ? `**${who.name}** (${who.modelId}): ${m.content}` : `**Host**: ${m.content}`);
  }
  if (d.summary) lines.push('', '## Summary', '', d.summary.text);
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Everything to put in the export zip, one entry at a time. Rows and blobs are read when each entry is reached
 * (never through an open iterator, which would block the database for other requests while the download runs).
 */
export async function* exportEntries(deps: Deps): AsyncGenerator<ZipEntry> {
  const { db, mediaDir } = deps;
  const chats = db.prepare('SELECT * FROM chats ORDER BY created_at').all() as (ChatRow & Record<string, unknown>)[];
  const hasClip = (id: string) => existsSync(clipPath(mediaDir, id));

  const data = {
    exportedAt: new Date().toISOString(),
    // Every column, so columns added later come along without changes here.
    chats,
    messages: db.prepare('SELECT * FROM messages ORDER BY seq').all(),
    attachments: db.prepare('SELECT id, message_id, position, kind, filename, mime, size, created_at FROM attachments WHERE message_id IS NOT NULL ORDER BY created_at').all(),
    mediaGenerations: db.prepare('SELECT * FROM media_generations').all(),
    discussions: db.prepare('SELECT * FROM discussions').all(),
    discussionParticipants: db.prepare('SELECT * FROM discussion_participants ORDER BY chat_id, position').all(),
    memories: db.prepare('SELECT * FROM memories ORDER BY created_at, id').all(),
    // Personalization (about_me, custom_instructions) and every other setting, but never the API key.
    settings: Object.fromEntries((db.prepare("SELECT key, value FROM settings WHERE key != 'api_key'").all() as { key: string; value: string }[]).map((r) => [r.key, r.value])),
  };
  yield { name: `${ROOT}/data.json`, data: () => [Buffer.from(JSON.stringify(data, null, 2))] };

  for (const chat of chats) {
    if (!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chat.id)) continue; // deleted while exporting
    const md = chat.kind === 'discussion'
      ? discussionMarkdown(getDiscussionDetail(db, chat.id))
      : threadMarkdown(chat, getChatMessages(db, chat.id), hasClip);
    yield { name: `${ROOT}/${threadPath(chat)}`, data: () => [Buffer.from(md)] };
  }

  const files = db.prepare('SELECT id, filename FROM attachments WHERE message_id IS NOT NULL ORDER BY created_at').all() as { id: string; filename: string }[];
  for (const f of files) {
    yield { name: `${ROOT}/${attachmentPath(f.id, f.filename)}`, data: () => { const b = getAttachmentData(db, f.id); return b ? [b] : []; } };
  }

  const clips = db.prepare("SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.kind = 'video' AND m.role = 'assistant'").all() as { id: string }[];
  for (const { id } of clips) {
    const file = clipPath(mediaDir, id);
    if (!existsSync(file)) continue;
    yield { name: `${ROOT}/clips/${id}.mp4`, size: statSync(file).size, data: () => createReadStream(file) };
  }
}
