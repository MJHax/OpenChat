import { extractText, getDocumentProxy } from 'unpdf';
import type { DB } from './db';
import { isLocalModelId } from '../../shared/localModels';
import { getChatMessages } from './messages';
import { activePath } from './tree';

/** Local models can't take a PDF file, so they get its text: pulled out once per file and kept in `pdf_text`. */
export async function extractPdfText(data: Buffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  } catch {
    return '';
  }
}

/** The cache key sits on the attachment's hash, so the same file attached twice is read once. */
const KEY = "COALESCE(hash, 'id:' || id)";

/** Extracts and stores the text of every PDF among `attachmentIds` that has not been read yet. */
export async function ensurePdfText(db: DB, attachmentIds: string[]): Promise<void> {
  if (attachmentIds.length === 0) return;
  const rows = db.prepare(
    `SELECT id, ${KEY} AS key FROM attachments WHERE kind = 'pdf' AND id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(attachmentIds)) as { id: string; key: string }[];
  const has = db.prepare('SELECT 1 FROM pdf_text WHERE key = ?').pluck();
  const read = db.prepare('SELECT data FROM attachments WHERE id = ?').pluck();
  const write = db.prepare('INSERT OR REPLACE INTO pdf_text (key, text) VALUES (?, ?)');
  const done = new Set<string>();
  for (const { id, key } of rows) {
    if (done.has(key) || has.get(key)) continue;
    done.add(key);
    write.run(key, await extractPdfText(read.get(id) as Buffer));
  }
}

/** The stored text of a PDF attachment; null when it has not been extracted. */
export function cachedPdfText(db: DB, attachmentId: string): string | null {
  const text = db.prepare(
    `SELECT text FROM pdf_text WHERE key = (SELECT ${KEY} FROM attachments WHERE id = ?)`,
  ).pluck().get(attachmentId) as string | undefined;
  return text ?? null;
}

/** PDF attachment ids on the active path ending at `parentId`. */
export function pathPdfIds(db: DB, chatId: string, parentId: string | null): string[] {
  return activePath(getChatMessages(db, chatId), parentId).flatMap((m) => m.attachments.filter((a) => a.kind === 'pdf').map((a) => a.id));
}

/** How a prompt or estimate for `modelId` reads PDFs: as text for a local model, undefined (the file itself) otherwise. */
export const pdfTextFor = (db: DB, modelId: string): ((id: string) => string | null) | undefined =>
  isLocalModelId(modelId) ? (id) => cachedPdfText(db, id) : undefined;
