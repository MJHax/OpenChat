import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import {
  createChat, deleteChat, getChatDetail, listChats, parseInstructions, renameChat, requireChat, setActiveLeaf, setCompareParent, setContextNote,
  setInstructions,
} from '../chats';
import { continueChat } from '../continue';
import { forkChat } from '../fork';
import { getChatMessages, getMessage } from '../messages';
import { newestLeafFrom, repliesTo } from '../tree';
import { computeChatStats } from '../stats';
import { loadChatUsageRows } from '../usage';
import { computeMediaThreadStats, loadMediaEvents } from '../mediaStats';
import { deleteThreadClips } from '../videoJobs';
import { purgeDeleted } from '../dataStore';
import type { ThreadKind } from '../../../shared/types';

const KINDS: ThreadKind[] = ['chat', 'image', 'video', 'discussion'];

function threadKind(kind: unknown): ThreadKind {
  if (kind === undefined || kind === null || kind === '') return 'chat';
  if (!KINDS.includes(kind as ThreadKind)) throw new HttpError(400, 'Unknown thread kind.');
  return kind as ThreadKind;
}

export function chatRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/', (c) => c.json(listChats(db, threadKind(c.req.query('kind')))));

  r.post('/', async (c) => {
    // A body is optional: a plain POST makes a chat.
    const body = c.req.header('content-type') ? await readJson<{ kind?: string; instructions?: unknown }>(c) : {};
    const kind = threadKind(body.kind);
    // A discussion needs its topic and participants, which only /api/discussions takes.
    if (kind === 'discussion') throw new HttpError(400, 'Create discussions from the Discussion tab.');
    return c.json(createChat(db, kind, parseInstructions(body.instructions)), 201);
  });

  r.get('/:id', (c) => c.json(getChatDetail(db, c.req.param('id'))));

  r.get('/:id/stats', (c) => {
    const id = c.req.param('id');
    const chat = requireChat(db, id);
    if (chat.kind === 'image' || chat.kind === 'video') return c.json(computeMediaThreadStats(loadMediaEvents(db, chat.kind, id), loadChatUsageRows(db, id)));
    return c.json(computeChatStats(loadChatUsageRows(db, id)));
  });

  r.patch('/:id', async (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    const body = await readJson<{ title?: string; selectMessageId?: string; instructions?: unknown; contextNote?: unknown }>(c);
    const instructions = parseInstructions(body.instructions);
    if (instructions !== undefined) setInstructions(db, id, instructions);
    const note = parseInstructions(body.contextNote, 'The context note');
    if (note !== undefined) setContextNote(db, requireChat(db, id), note);
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

  /** "Summarize and continue": the summary is written by `modelId`, the chat's current model. */
  r.post('/:id/continue', async (c) => {
    const body = await readJson<{ modelId?: unknown; allowOverflow?: unknown }>(c);
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) throw new HttpError(400, 'Pick a model first.');
    return c.json(await continueChat(deps, c.req.param('id'), body.modelId.trim(), body.allowOverflow === true), 201);
  });

  /** A new chat holding the conversation up to `messageId`, to take it somewhere else without touching this one. */
  r.post('/:id/fork', async (c) => {
    const body = await readJson<{ messageId?: unknown }>(c);
    if (typeof body.messageId !== 'string' || !body.messageId) throw new HttpError(400, 'messageId is required.');
    return c.json(forkChat(db, c.req.param('id'), body.messageId), 201);
  });

  r.delete('/:id', (c) => {
    const id = c.req.param('id');
    requireChat(db, id);
    deleteThreadClips(deps, id);
    deleteChat(db, id);
    purgeDeleted(db);
    return c.json({ ok: true });
  });

  return r;
}
