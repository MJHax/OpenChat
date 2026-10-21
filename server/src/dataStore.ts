import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Deps } from './app';
import type { DB } from './db';
import { HttpError } from './http';
import { deleteThreadClips } from './videoJobs';
import type { DeleteTarget, StorageUsage, ThreadKind } from '../../shared/types';

export const DELETE_TARGETS: DeleteTarget[] = ['chats', 'images', 'videos', 'discussions', 'all'];

const THREAD_KIND: Record<Exclude<DeleteTarget, 'all'>, ThreadKind> = {
  chats: 'chat', images: 'image', videos: 'video', discussions: 'discussion',
};

/**
 * Makes a delete final on disk. secure_delete zeroes freed pages, but the search index keeps deleted words in old
 * segments until they are merged, and the WAL keeps old page versions until a checkpoint copies them back.
 */
export function purgeDeleted(db: DB): void {
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')").run();
  db.pragma('wal_checkpoint(TRUNCATE)');
}

const fileSize = (file: string) => (existsSync(file) ? statSync(file).size : 0);

const clipFiles = (mediaDir: string) => (existsSync(mediaDir) ? readdirSync(mediaDir).filter((f) => f.endsWith('.mp4')) : []);

const one = (db: DB, sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;

/** Bytes on disk: the database (with its WAL) and the clip files, split by what they hold. */
export function storageUsage({ db, mediaDir }: Deps): StorageUsage {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const database = (db.pragma('page_count', { simple: true }) as number) * pageSize;
  const wal = db.memory ? 0 : fileSize(`${db.name}-wal`);
  const text = 'SUM(length(CAST(m.content AS BLOB)) + COALESCE(length(CAST(m.sources AS BLOB)), 0))';
  const discussions = one(db, `SELECT ${text} AS n FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.kind = 'discussion'`);
  const messages = one(db, `SELECT ${text} AS n FROM messages m`) - discussions;
  const images = one(db,
    "SELECT SUM(a.size) AS n FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.role = 'assistant' AND a.kind = 'image'");
  const uploads = one(db, 'SELECT SUM(size) AS n FROM attachments') - images;
  const videos = clipFiles(mediaDir).reduce((t, f) => t + fileSize(join(mediaDir, f)), 0);
  const reclaimable = (db.pragma('freelist_count', { simple: true }) as number) * pageSize + wal;
  const other = Math.max(0, database + wal + videos - messages - discussions - images - uploads - videos - reclaimable);
  return {
    total: messages + discussions + uploads + images + videos + reclaimable + other,
    parts: { messages, discussions, uploads, images, videos, reclaimable, other },
  };
}

/** Gives the space of deleted content back to the disk. VACUUM rewrites the whole file, so it can take a while. */
export function cleanUp(db: DB): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** A clip that is still rendering is already paid for; deleting its thread would throw the clip away. */
function refuseWhileRendering(db: DB): void {
  if (db.prepare('SELECT 1 FROM video_jobs j JOIN chats c ON c.id = j.thread_id WHERE j.finished_at IS NULL').get()) {
    throw new HttpError(409, 'A clip is still rendering. It is already paid for, so wait for it to finish, then delete.');
  }
}

// Every table that holds the user's data; "Delete all my data" empties them all (settings is handled on its own).
const ALL_TABLES = ['chats', 'attachments', 'memories', 'saved_prompts', 'models', 'media_models', 'usage_events', 'media_events', 'video_jobs',
  'model_catalog_cache', 'media_catalog_cache', 'local_servers', 'sqlite_sequence'];

/** Deletes one kind of thread, or everything ('all'). Returns the ids of the deleted threads. */
export function deleteData(deps: Deps, target: DeleteTarget): { chatIds: string[] } {
  const { db, mediaDir } = deps;
  if (target === 'videos' || target === 'all') refuseWhileRendering(db);
  const kind = target === 'all' ? null : THREAD_KIND[target];
  const chatIds = (kind ? db.prepare('SELECT id FROM chats WHERE kind = ?').all(kind) : db.prepare('SELECT id FROM chats').all()) as { id: string }[];
  for (const { id } of chatIds) deleteThreadClips(deps, id);
  db.transaction(() => {
    if (kind) {
      db.prepare('DELETE FROM chats WHERE kind = ?').run(kind);
      if (kind === 'video') db.prepare('DELETE FROM video_jobs WHERE finished_at IS NOT NULL').run();
      return;
    }
    for (const table of ALL_TABLES) db.exec(`DELETE FROM ${table}`);
    // Kept so the one-time copy of old replies into the usage log never runs again.
    db.prepare("DELETE FROM settings WHERE key != 'usage_backfill_done'").run();
  })();
  // Clips no thread owns any more go too, and on a reset everything in the folder (unfinished downloads included).
  if (target === 'videos' || target === 'all') {
    for (const f of existsSync(mediaDir) ? readdirSync(mediaDir) : []) {
      if (f.endsWith('.mp4') || target === 'all') rmSync(join(mediaDir, f), { force: true, recursive: true });
    }
  }
  purgeDeleted(db);
  if (target === 'all') cleanUp(db);
  return { chatIds: chatIds.map((r) => r.id) };
}
