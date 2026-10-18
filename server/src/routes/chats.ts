import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { createChat, deleteChat, getChatDetail, listChats, renameChat, requireChat, setActiveLeaf, setCompareParent } from '../chats';
import { getChatMessages, getMessage } from '../messages';
import { newestLeafFrom, repliesTo } from '../tree';
import { computeChatStats } from '../stats';
import { loadChatUsageRows } from '../usage';
import type { ThreadKind } from '../../../shared/types';

const KINDS: ThreadKind[] = ['chat', 'image', 'video'];

function threadKind(kind: unknown): ThreadKind {
  if (kind === undefined || kind === null || kind === '') return 'chat';
  if (!KINDS.includes(kind as ThreadKind)) throw new HttpError(400, 'Unknown thread kind.');
  return kind as ThreadKind;
}

export function chatRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => c.json(listChats(db, threadKind(c.req.query('kind')))));

  r.post('/', async (c) => {
    // A body is optional: a plain POST makes a chat.
    const kind = c.req.header('content-type') ? (await readJson<{ kind?: string }>(c)).kind : undefined;
    return c.json(createChat(db, threadKind(kind)), 201);
  });

  r.get('/:id', (c) => c.json(getChatDetail(db, c.req.param('id'))));

  r.get('/:id/stats', (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    return c.json(computeChatStats(loadChatUsageRows(db, id)));
  });

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
      setCompareParent(db, id, null); // choosing a reply settles any pending comparison
    }
    return c.json(getChatDetail(db, id));
  });

  r.get('/:id/replies', (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    const parent = getMessage(db, c.req.query('parentId') ?? '');
    if (!parent || parent.chatId !== id || parent.role !== 'user') throw new HttpError(400, 'parentId must be a user message in this chat.');
    return c.json(repliesTo(getChatMessages(db, id), parent.id));
  });

  r.delete('/:id', (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    deleteChat(db, id);
    return c.json({ ok: true });
  });

  return r;
}
