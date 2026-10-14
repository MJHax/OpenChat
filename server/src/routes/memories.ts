import { Hono } from 'hono';
import type { Deps } from '../app';
import type { DB } from '../db';
import { now } from '../db';
import { HttpError, readJson } from '../http';
import type { Memory } from '../../../shared/types';

interface MemoryRow { id: number; content: string; enabled: number; created_at: number }

const toMemory = (r: MemoryRow): Memory => ({ id: r.id, content: r.content, enabled: r.enabled === 1, createdAt: r.created_at });

function requireMemory(db: DB, id: number): MemoryRow {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  if (!row) throw new HttpError(404, 'Memory not found.');
  return row;
}

function cleanContent(content: unknown): string {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new HttpError(400, 'Memory cannot be empty.');
  return text;
}

export function memoryRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const rows = db.prepare('SELECT * FROM memories ORDER BY created_at, id').all() as MemoryRow[];
    return c.json(rows.map(toMemory));
  });

  r.post('/', async (c) => {
    const { content } = await readJson<{ content?: string }>(c);
    const info = db.prepare('INSERT INTO memories (content, enabled, created_at) VALUES (?, 1, ?)').run(cleanContent(content), now());
    return c.json(toMemory(requireMemory(db, Number(info.lastInsertRowid))), 201);
  });

  r.patch('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    requireMemory(db, id);
    const body = await readJson<{ content?: string; enabled?: boolean }>(c);
    if (body.content !== undefined) db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(cleanContent(body.content), id);
    if (body.enabled !== undefined) db.prepare('UPDATE memories SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, id);
    return c.json(toMemory(requireMemory(db, id)));
  });

  r.delete('/:id', (c) => {
    const id = Number(c.req.param('id'));
    requireMemory(db, id);
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  return r;
}
