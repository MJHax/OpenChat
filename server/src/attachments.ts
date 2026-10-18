import type { DB } from './db';
import { newId, now } from './db';
import { HttpError } from './http';
import { displayNameOf, modelModalities } from './library';
import {
  BAD_ATTACHMENT, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, PENDING_TTL_MS, TOO_MANY_FILES, TOO_MUCH_TOTAL, canViewImages,
} from '../../shared/attachments';
import type { Attachment, AttachmentKind } from '../../shared/types';

export type AttachmentRow = Attachment & { messageId: string | null };

interface Row {
  id: string;
  message_id: string | null;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
}

const toAttachment = (r: Row): Attachment => ({ id: r.id, kind: r.kind, filename: r.filename, mime: r.mime, size: r.size });
const META = 'id, message_id, kind, filename, mime, size';

const startsWith = (bytes: Uint8Array, prefix: number[], offset = 0): boolean =>
  bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const IMAGE_SIGNATURES: { mime: string; test(b: Uint8Array): boolean }[] = [
  { mime: 'image/png', test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', test: (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')) },
  { mime: 'image/webp', test: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8) },
];

const BOM = [0xef, 0xbb, 0xbf];

/** Decides what a file is from its bytes alone; null for empty files and anything OpenChat can't read. */
export function detectKind(bytes: Uint8Array): { kind: AttachmentKind; mime: string; bytes: Uint8Array } | null {
  if (bytes.length === 0) return null;
  const image = IMAGE_SIGNATURES.find((s) => s.test(bytes));
  if (image) return { kind: 'image', mime: image.mime, bytes };
  if (startsWith(bytes, ascii('%PDF-'))) return { kind: 'pdf', mime: 'application/pdf', bytes };
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return { kind: 'text', mime: 'text/plain', bytes: startsWith(bytes, BOM) ? bytes.subarray(BOM.length) : bytes };
}

export function cleanFilename(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return clean || 'file';
}

export function insertPending(db: DB, a: { filename: string; kind: AttachmentKind; mime: string; data: Uint8Array }): Attachment {
  const id = newId();
  db.prepare('INSERT INTO attachments (id, message_id, kind, filename, mime, size, data, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
    .run(id, a.kind, a.filename, a.mime, a.data.length, Buffer.from(a.data), now());
  return { id, kind: a.kind, filename: a.filename, mime: a.mime, size: a.data.length };
}

export function getAttachmentRow(db: DB, id: string): AttachmentRow | undefined {
  const r = db.prepare(`SELECT ${META} FROM attachments WHERE id = ?`).get(id) as Row | undefined;
  return r && { ...toAttachment(r), messageId: r.message_id };
}

export function getAttachmentData(db: DB, id: string): Buffer | undefined {
  return (db.prepare('SELECT data FROM attachments WHERE id = ?').get(id) as { data: Buffer } | undefined)?.data;
}

export function deletePending(db: DB, id: string): 'deleted' | 'sent' | 'missing' {
  const row = getAttachmentRow(db, id);
  if (!row) return 'missing';
  if (row.messageId) return 'sent';
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  return 'deleted';
}

/** Deletes uploads that were never sent; returns how many were removed. */
export function cleanupPending(db: DB, olderThanMs = PENDING_TTL_MS): number {
  return db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?').run(now() - olderThanMs).changes;
}

/**
 * Looks up the attachments a send or edit refers to, in request order. Each must be pending, or (for an edit)
 * belong to the message being edited. Throws a 400 for anything else.
 */
export function resolveAttachmentIds(db: DB, ids: unknown, opts: { editedMessageId: string | null }): AttachmentRow[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new HttpError(400, BAD_ATTACHMENT);
  if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, TOO_MANY_FILES);
  const rows = ids.map((id) => {
    const row = typeof id === 'string' ? getAttachmentRow(db, id) : undefined;
    const allowed = row && (row.messageId === null || (opts.editedMessageId !== null && row.messageId === opts.editedMessageId));
    if (!allowed) throw new HttpError(400, BAD_ATTACHMENT);
    return row;
  });
  if (rows.reduce((sum, r) => sum + r.size, 0) > MAX_TOTAL_BYTES) throw new HttpError(400, TOO_MUCH_TOTAL);
  return rows;
}

/** Gives `messageId` the attachments in order: pending ones are claimed, ones owned by another message are copied. */
export function attachToMessage(db: DB, messageId: string, list: AttachmentRow[]): void {
  const claim = db.prepare('UPDATE attachments SET message_id = ?, position = ? WHERE id = ?');
  const copy = db.prepare(
    `INSERT INTO attachments (id, message_id, position, kind, filename, mime, size, data, created_at)
     SELECT ?, ?, ?, kind, filename, mime, size, data, ? FROM attachments WHERE id = ?`,
  );
  list.forEach((a, position) => {
    if (a.messageId === null) claim.run(messageId, position, a.id);
    else copy.run(newId(), messageId, position, now(), a.id);
  });
}

/** Rejects new images for any model that can't view them; older images are handled by the prompt builder. */
export function requireViewable(db: DB, modelIds: string[], list: Attachment[]): void {
  if (!list.some((a) => a.kind === 'image')) return;
  const blind = modelIds.find((id) => !canViewImages(modelModalities(db, id)));
  if (blind) throw new HttpError(400, `${displayNameOf(db, blind)} can't view images.`);
}

/** Attachment metadata for each of `messageIds` that has any, in position order. */
export function attachmentsFor(db: DB, messageIds: string[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return out;
  const rows = db.prepare(
    `SELECT ${META} FROM attachments WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY position`,
  ).all(JSON.stringify(messageIds)) as Row[];
  for (const r of rows) {
    const list = out.get(r.message_id!) ?? [];
    list.push(toAttachment(r));
    out.set(r.message_id!, list);
  }
  return out;
}

/** Stores a generated file (an image a model made) on the assistant message that produced it. */
export function insertGenerated(db: DB, a: { messageId: string; filename: string; kind: AttachmentKind; mime: string; data: Uint8Array }): Attachment {
  const id = newId();
  db.prepare('INSERT INTO attachments (id, message_id, position, kind, filename, mime, size, data, created_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)')
    .run(id, a.messageId, a.kind, a.filename, a.mime, a.data.length, a.data, now());
  return { id, kind: a.kind, filename: a.filename, mime: a.mime, size: a.data.length };
}

/** Images attached anywhere in the chat, newest first; when names repeat, only the newest of that name is kept. */
export function chatImages(db: DB, chatId: string): Attachment[] {
  const rows = db.prepare(
    `SELECT a.id, a.message_id, a.kind, a.filename, a.mime, a.size FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE m.chat_id = ? AND a.kind = 'image' ORDER BY a.created_at DESC, a.rowid DESC`,
  ).all(chatId) as Row[];
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.filename) && seen.add(r.filename)).map(toAttachment);
}

/** The names a generated page can use to show the chat's images. */
export const chatImageNames = (db: DB, chatId: string): string[] => chatImages(db, chatId).map((a) => a.filename);
