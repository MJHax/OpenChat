import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { createChat, deleteChat, getChatDetail, listChats, renameChat, requireChat, setActiveLeaf } from '../chats';
import { getChatMessages } from '../messages';
import { newestLeafFrom } from '../tree';

export function chatRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(listChats(db)));

  r.post('/', (c) => c.json(createChat(db), 201));

  r.get('/:id', (c) => c.json(getChatDetail(db, c.req.param('id'))));

  r.patch('/:id', async (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    const body = await readJson<{ title?: string; selectMessageId?: string }>(c);
    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) throw new HttpError(400, 'Title cannot be empty.');
      renameChat(db, id, title.slice(0, 200));
    }
    if (body.selectMessageId !== undefined) {
      const all = getChatMessages(db, id);
      if (!all.some((m) => m.id === body.selectMessageId)) throw new HttpError(400, 'Message is not in this chat.');
      setActiveLeaf(db, id, newestLeafFrom(all, body.selectMessageId));
    }
    return c.json(getChatDetail(db, id));
  });

  r.delete('/:id', (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    deleteChat(db, id);
    return c.json({ ok: true });
  });

  return r;
}
