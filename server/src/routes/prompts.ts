import { Hono } from 'hono';
import type { Deps } from '../app';
import type { DB } from '../db';
import { now } from '../db';
import { HttpError, readJson } from '../http';
import type { SavedPrompt } from '../../../shared/types';

interface PromptRow { id: number; title: string; content: string; created_at: number; updated_at: number }

const toPrompt = (r: PromptRow): SavedPrompt => ({ id: r.id, title: r.title, content: r.content, createdAt: r.created_at, updatedAt: r.updated_at });

function requirePrompt(db: DB, id: number): PromptRow {
  const row = db.prepare('SELECT * FROM saved_prompts WHERE id = ?').get(id) as PromptRow | undefined;
  if (!row) throw new HttpError(404, 'Prompt not found.');
  return row;
}

const cleanTitle = (title: unknown): string => (typeof title === 'string' ? title.trim() : '');

/** Blank lines around the prompt go, but its indentation stays: a saved snippet of code needs it. */
function cleanContent(content: unknown): string {
  const text = typeof content === 'string' ? content.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd() : '';
  if (!text.trim()) throw new HttpError(400, 'Prompt cannot be empty.');
  return text;
}

export function promptRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/', (c) => {
    const rows = db.prepare('SELECT * FROM saved_prompts ORDER BY updated_at DESC, id DESC').all() as PromptRow[];
    return c.json(rows.map(toPrompt));
  });

  r.post('/', async (c) => {
    const { title, content } = await readJson<{ title?: string; content?: string }>(c);
    const at = now();
    const info = db.prepare('INSERT INTO saved_prompts (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(cleanTitle(title), cleanContent(content), at, at);
    return c.json(toPrompt(requirePrompt(db, Number(info.lastInsertRowid))), 201);
  });

  r.patch('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const row = requirePrompt(db, id);
    const body = await readJson<{ title?: string; content?: string }>(c);
    const title = body.title !== undefined ? cleanTitle(body.title) : row.title;
    const content = body.content !== undefined ? cleanContent(body.content) : row.content;
    db.prepare('UPDATE saved_prompts SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(title, content, now(), id);
    return c.json(toPrompt(requirePrompt(db, id)));
  });

  r.delete('/:id', (c) => {
    const id = Number(c.req.param('id'));
    requirePrompt(db, id);
    db.prepare('DELETE FROM saved_prompts WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  return r;
}
