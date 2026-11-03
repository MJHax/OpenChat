import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Deps } from './app';
import { SCHEMA_VERSION } from './db';
import type { ZipEntry } from './zip';

/** Settings never written into an export or a backup. */
export const SECRET_SETTINGS = ['api_key', 'tavily_api_key'] as const;

/** Where the backup sits inside the export zip. */
export const BACKUP_DIR = 'openchat-export/backup';

export interface BackupManifest { format: 'openchat-backup'; formatVersion: 1; schemaVersion: number; createdAt: string }

/** A complete copy of the database with the secret settings wiped, made when the zip writer reaches it. */
async function* databaseCopy(deps: Deps, workDir: string): AsyncGenerator<Uint8Array> {
  const file = join(workDir, `openchat-backup-${randomUUID()}.db`);
  try {
    // VACUUM INTO writes a consistent, compact copy, including what is still only in the WAL.
    deps.db.prepare('VACUUM INTO ?').run(file);
    const copy = new Database(file);
    try {
      copy.pragma('journal_mode = DELETE');
      copy.pragma('secure_delete = ON');
      copy.prepare(`DELETE FROM settings WHERE key IN (${SECRET_SETTINGS.map(() => '?').join(', ')})`).run(...SECRET_SETTINGS);
      // Rewrites the file, so no freed page keeps the deleted keys.
      copy.exec('VACUUM');
    } finally {
      copy.close();
    }
    yield* createReadStream(file);
  } finally {
    rmSync(file, { force: true });
  }
}

/** The backup part of the export: a manifest, the database copy and every clip file. */
export async function* backupEntries(deps: Deps, workDir = tmpdir()): AsyncGenerator<ZipEntry> {
  const manifest: BackupManifest = { format: 'openchat-backup', formatVersion: 1, schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString() };
  yield { name: `${BACKUP_DIR}/manifest.json`, data: () => [Buffer.from(JSON.stringify(manifest, null, 2))] };
  yield { name: `${BACKUP_DIR}/openchat.db`, data: () => databaseCopy(deps, workDir) };
  const clips = existsSync(deps.mediaDir) ? readdirSync(deps.mediaDir).filter((f) => f.endsWith('.mp4')) : [];
  for (const name of clips) {
    const file = join(deps.mediaDir, name);
    if (!existsSync(file)) continue;
    yield { name: `${BACKUP_DIR}/clips/${name}`, size: statSync(file).size, data: () => createReadStream(file) };
  }
}
