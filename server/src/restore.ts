import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Deps } from './app';
import { busyReason } from './activity';
import { BACKUP_DIR, SECRET_SETTINGS, type BackupManifest } from './backup';
import { now, openDb, SCHEMA_VERSION, type DB } from './db';
import { purgeDeleted } from './dataStore';
import { HttpError } from './http';
import { failInterruptedGenerations } from './imageGen';
import { extractEntry, readZipIndex, ZipError, type ZipFileEntry } from './unzip';

const NOT_A_BACKUP = "This isn't an OpenChat backup. Use a .zip made by Export in OpenChat.";
const NEWER = 'This backup was made by a newer version of OpenChat. Update this OpenChat first.';
const DAMAGED = 'The backup file is damaged or incomplete. Export it again and retry.';
const INTERRUPTED_CLIP = 'Interrupted by a restore. The clip may still finish on the OpenChat this backup came from.';
const CLIP_NAME = /^[0-9a-f-]{36}\.mp4$/;

/** The manifest, checked; anything that isn't one of ours is refused here. */
async function readManifest(zipFile: string, entry: ZipFileEntry | undefined, dir: string): Promise<BackupManifest> {
  if (!entry) throw new HttpError(400, NOT_A_BACKUP);
  const file = join(dir, 'manifest.json');
  await extractEntry(zipFile, entry, file);
  let m: Partial<BackupManifest>;
  try {
    m = JSON.parse(readFileSync(file, 'utf8')) as Partial<BackupManifest>;
  } catch {
    throw new HttpError(400, NOT_A_BACKUP);
  }
  if (m.format !== 'openchat-backup' || m.formatVersion !== 1 || typeof m.schemaVersion !== 'number') throw new HttpError(400, NOT_A_BACKUP);
  if (m.schemaVersion > SCHEMA_VERSION) throw new HttpError(400, NEWER);
  return m as BackupManifest;
}

/** Brings the backup's database up to this schema and settles work that was running when it was made. */
function prepareCopy(file: string): void {
  let version: number;
  try {
    const probe = new Database(file, { readonly: true, fileMustExist: true });
    try {
      version = probe.pragma('user_version', { simple: true }) as number;
    } finally {
      probe.close();
    }
  } catch {
    throw new HttpError(400, DAMAGED);
  }
  if (version > SCHEMA_VERSION) throw new HttpError(400, NEWER);
  let copy: DB;
  try {
    copy = openDb(file);
  } catch {
    throw new HttpError(400, DAMAGED);
  }
  try {
    failInterruptedGenerations(copy);
    // Never resumed: the instance that made the backup may still be polling the same job.
    const at = now();
    const jobs = copy.prepare('SELECT job_id, message_id FROM video_jobs WHERE finished_at IS NULL').all() as { job_id: string; message_id: string }[];
    copy.transaction(() => {
      for (const j of jobs) {
        copy.prepare('UPDATE video_jobs SET finished_at = ? WHERE job_id = ?').run(at, j.job_id);
        copy.prepare("UPDATE messages SET status = 'error' WHERE id = ?").run(j.message_id);
        copy.prepare('UPDATE media_generations SET error = ?, finished_at = ? WHERE message_id = ?').run(INTERRUPTED_CLIP, at, j.message_id);
      }
      copy.prepare(`DELETE FROM settings WHERE key IN (${SECRET_SETTINGS.map(() => '?').join(', ')})`).run(...SECRET_SETTINGS);
    })();
  } finally {
    copy.close();
  }
}

/** Every table that holds data, leaving out SQLite's own and the search index (rebuilt afterwards). */
function dataTables(db: DB, schema: 'main' | 'backup'): string[] {
  return (db.prepare(
    `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'
       AND (name NOT LIKE 'sqlite\\_%' ESCAPE '\\' OR name = 'sqlite_sequence')
       AND name != 'messages_fts' AND name NOT GLOB 'messages_fts_*'`,
  ).all() as { name: string }[]).map((r) => r.name);
}

const columns = (db: DB, schema: 'main' | 'backup', table: string) =>
  (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);

/** Replaces every row in the live database with the backup's, in one transaction, keeping this instance's keys. */
function copyRows(db: DB, file: string): void {
  const keys = db.prepare(`SELECT key, value FROM settings WHERE key IN (${SECRET_SETTINGS.map(() => '?').join(', ')})`).all(...SECRET_SETTINGS) as { key: string; value: string }[];
  db.prepare('ATTACH DATABASE ? AS backup').run(file);
  try {
    const inBackup = new Set(dataTables(db, 'backup'));
    const tables = dataTables(db, 'main');
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      for (const t of tables) db.exec(`DELETE FROM main."${t}"`);
      for (const t of tables) {
        if (!inBackup.has(t)) continue;
        const shared = columns(db, 'backup', t);
        const cols = columns(db, 'main', t).filter((c) => shared.includes(c)).map((c) => `"${c}"`).join(', ');
        db.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM backup."${t}"`);
      }
      const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const k of keys) put.run(k.key, k.value);
      db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')").run();
    })();
  } finally {
    db.prepare('DETACH DATABASE backup').run();
  }
}

/**
 * Replaces everything in this instance with a backup made by Export. Everything is checked and staged first, so any
 * failure before the copy commits leaves the database and the clip folder exactly as they were.
 */
export async function restoreBackup(deps: Deps, zipFile: string): Promise<void> {
  const busy = busyReason(deps);
  if (busy) throw new HttpError(409, busy);
  const work = mkdtempSync(join(tmpdir(), 'openchat-restore-'));
  const staging = `${deps.mediaDir}.restoring`;
  try {
    let index: Map<string, ZipFileEntry>;
    try {
      index = await readZipIndex(zipFile);
    } catch (err) {
      if (err instanceof ZipError) throw new HttpError(400, DAMAGED);
      throw err;
    }
    await readManifest(zipFile, index.get(`${BACKUP_DIR}/manifest.json`), work);

    const dbEntry = index.get(`${BACKUP_DIR}/openchat.db`);
    if (!dbEntry) throw new HttpError(400, DAMAGED);
    const clipPrefix = `${BACKUP_DIR}/clips/`;
    const clips = [...index.values()].filter((e) => e.name.startsWith(clipPrefix));
    if (clips.some((e) => !CLIP_NAME.test(e.name.slice(clipPrefix.length)))) throw new HttpError(400, DAMAGED);

    const copyFile = join(work, 'openchat.db');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      await extractEntry(zipFile, dbEntry, copyFile);
      prepareCopy(copyFile);
      for (const e of clips) await extractEntry(zipFile, e, join(staging, e.name.slice(clipPrefix.length)));
    } catch (err) {
      if (err instanceof ZipError) throw new HttpError(400, DAMAGED);
      throw err;
    }

    try {
      copyRows(deps.db, copyFile);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.error(err);
      throw new HttpError(400, DAMAGED);
    }

    const old = `${deps.mediaDir}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(deps.mediaDir)) renameSync(deps.mediaDir, old);
    renameSync(staging, deps.mediaDir);
    rmSync(old, { recursive: true, force: true });
    purgeDeleted(deps.db);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
