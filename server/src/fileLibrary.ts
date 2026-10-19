import { existsSync, statSync } from 'node:fs';
import type { DB } from './db';
import { hashBytes } from './db';
import { getChatMessages, getMessage } from './messages';
import { activePath } from './tree';
import { clipPath } from './videoJobs';
import { fileVersions, parseFileBlocks, safeFileName } from '../../shared/files';
import { libraryType } from '../../shared/library';
import type { AttachmentKind, LibraryChatRef, LibraryItem, LibraryResponse, ThreadKind } from '../../shared/types';

/** One file as the Library shows it while it is being built: the copy it stands for, and every chat it is in. */
interface Group {
  item: Omit<LibraryItem, 'chats' | 'createdAt'>;
  /** When the copy in `item.source` appeared; a newer copy replaces it. */
  at: number;
  chats: Map<string, LibraryChatRef>;
}

interface AttachmentHit {
  id: string;
  kind: AttachmentKind;
  filename: string;
  size: number;
  hash: string;
  at: number;
  chatId: string;
  chatKind: ThreadKind;
  title: string;
}

const ATTACHMENT_HITS = `
  SELECT a.id, a.kind, a.filename, a.size, COALESCE(a.origin_hash, a.hash) AS hash, m.created_at AS at, c.id AS chatId, c.kind AS chatKind, c.title
  FROM attachments a JOIN messages m ON m.id = a.message_id JOIN chats c ON c.id = m.chat_id`;

const ref = (chatId: string, kind: ThreadKind, title: string, at: number): LibraryChatRef => ({ chatId, kind, title, at });

function addChat(group: Group, chat: LibraryChatRef): void {
  const seen = group.chats.get(chat.chatId);
  if (!seen || chat.at > seen.at) group.chats.set(chat.chatId, chat);
}

/** Adds a copy to `groups` under `hash`; the newest copy becomes the one the item stands for. */
function addCopy(groups: Map<string, Group>, hash: string, item: Group['item'], chat: LibraryChatRef): Group {
  const group = groups.get(hash);
  if (!group) {
    const created: Group = { item, at: chat.at, chats: new Map() };
    addChat(created, chat);
    groups.set(hash, created);
    return created;
  }
  if (chat.at >= group.at) Object.assign(group, { item, at: chat.at });
  addChat(group, chat);
  return group;
}

const attachmentItem = (h: AttachmentHit): Group['item'] => ({
  key: `att:${h.id}`, type: libraryType(h.kind, h.filename), name: h.filename, size: h.size,
  source: { type: 'attachment', attachmentId: h.id, kind: h.kind },
});

function finish(groups: Iterable<Group>): LibraryItem[] {
  return [...groups]
    .map((g) => {
      const chats = [...g.chats.values()].sort((a, b) => b.at - a.at);
      return { ...g.item, createdAt: chats[0].at, chats };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Every uploaded and generated file, newest first. Copies with the same contents are one item listing each chat
 * they are in; an upload that is a copy of something OpenChat made counts toward that generated item instead.
 */
export function libraryItems(db: DB, mediaDir: string): LibraryResponse {
  const generated = new Map<string, Group>();
  /** Older versions of chat-written files, pointing at the item for that file. */
  const older = new Map<string, Group>();

  const images = db.prepare(`${ATTACHMENT_HITS} WHERE m.role = 'assistant' AND c.kind = 'image' AND a.kind = 'image' ORDER BY at, a.rowid`)
    .all() as AttachmentHit[];
  for (const h of images) addCopy(generated, h.hash, attachmentItem(h), ref(h.chatId, h.chatKind, h.title, h.at));

  const chats = db.prepare("SELECT id, title, active_leaf_id FROM chats WHERE kind = 'chat'").all() as
    { id: string; title: string; active_leaf_id: string | null }[];
  for (const chat of chats) {
    const messages = getChatMessages(db, chat.id);
    const byName = new Map<string, Group>();
    for (const versions of fileVersions(activePath(messages, chat.active_leaf_id)).values()) {
      const latest = versions.at(-1)!;
      if (!latest.file.complete) continue;
      const at = messages.find((m) => m.id === latest.messageId)!.createdAt;
      const item: Group['item'] = {
        key: `file:${latest.messageId}/${latest.name}`, type: libraryType('text', latest.name), name: latest.name,
        size: Buffer.byteLength(latest.file.content), source: { type: 'chatFile', messageId: latest.messageId, name: latest.name },
      };
      byName.set(latest.name, addCopy(generated, hashBytes(Buffer.from(latest.file.content)), item, ref(chat.id, 'chat', chat.title, at)));
    }
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const s of parseFileBlocks(m.content)) {
        if (s.type !== 'file' || !s.file.complete) continue;
        const group = byName.get(s.file.name);
        const hash = hashBytes(Buffer.from(s.file.content));
        if (group && !generated.has(hash) && !older.has(hash)) older.set(hash, group);
      }
    }
  }

  const uploads = new Map<string, Group>();
  const sent = db.prepare(`${ATTACHMENT_HITS} WHERE m.role = 'user' ORDER BY at, a.rowid`).all() as AttachmentHit[];
  for (const h of sent) {
    const chat = ref(h.chatId, h.chatKind, h.title, h.at);
    const made = generated.get(h.hash) ?? older.get(h.hash);
    if (made) addChat(made, chat);
    else addCopy(uploads, h.hash, attachmentItem(h), chat);
  }

  const clips = db.prepare(
    `SELECT j.message_id AS messageId, m.created_at AS at, c.id AS chatId, c.kind AS chatKind, c.title
     FROM video_jobs j JOIN messages m ON m.id = j.message_id JOIN chats c ON c.id = j.thread_id`,
  ).all() as { messageId: string; at: number; chatId: string; chatKind: ThreadKind; title: string }[];
  for (const clip of clips) {
    const path = clipPath(mediaDir, clip.messageId);
    if (!existsSync(path)) continue;
    const item: Group['item'] = {
      key: `video:${clip.messageId}`, type: 'video', name: safeFileName(`${clip.title || 'video'}.mp4`), size: statSync(path).size,
      source: { type: 'video', messageId: clip.messageId },
    };
    addCopy(generated, `video:${clip.messageId}`, item, ref(clip.chatId, clip.chatKind, clip.title, clip.at));
  }

  return { uploads: finish(uploads.values()), generated: finish(generated.values()) };
}

/** The last complete file named `name` in an assistant reply, as `copyGenerated` finds it. */
export function chatFileText(db: DB, messageId: string, name: string): string | undefined {
  const message = getMessage(db, messageId);
  if (message?.role !== 'assistant') return undefined;
  return parseFileBlocks(message.content).flatMap((s) => (s.type === 'file' && s.file.complete && s.file.name === name ? [s.file.content] : [])).at(-1);
}
