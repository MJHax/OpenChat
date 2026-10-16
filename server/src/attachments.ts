import type { DB } from './db';
import { newId, now } from './db';
import { PENDING_TTL_MS } from '../../shared/attachments';
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
