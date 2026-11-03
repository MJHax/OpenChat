import type { Deps } from './app';
import type { DB } from './db';
import { imageGenerationsRunning } from './imageGen';

interface WorkSets {
  /** Chats with a reply streaming. */
  replies: Set<string>;
  /** Discussions with a turn streaming. */
  turns: Set<string>;
}

const sets = new WeakMap<DB, WorkSets>();

/** The routes' in-flight sets, one pair per database, so an import can ask whether anything is still writing. */
export function workSets(db: DB): WorkSets {
  let s = sets.get(db);
  if (!s) {
    s = { replies: new Set(), turns: new Set() };
    sets.set(db, s);
  }
  return s;
}

/** Why replacing all data now would mix old and new rows, or null when nothing is running. */
export function busyReason({ db }: Deps): string | null {
  const { replies, turns } = workSets(db);
  if (replies.size) return 'A reply is still being written. Wait for it to finish, then import.';
  if (turns.size) return 'A discussion turn is still running. Wait for it to finish, then import.';
  if (imageGenerationsRunning()) return 'An image is still being generated. Wait for it to finish, then import.';
  // Any unfinished job, its thread deleted or not: it is paid for and still polled.
  if (db.prepare('SELECT 1 FROM video_jobs WHERE finished_at IS NULL').get()) {
    return 'A clip is still rendering. It is already paid for, so wait for it to finish, then import.';
  }
  return null;
}
