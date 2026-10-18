import type { DB } from './db';

/**
 * Makes a delete final on disk. secure_delete zeroes freed pages, but the search index keeps deleted words in old
 * segments until they are merged, and the WAL keeps old page versions until a checkpoint copies them back.
 */
export function purgeDeleted(db: DB): void {
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')").run();
  db.pragma('wal_checkpoint(TRUNCATE)');
}
