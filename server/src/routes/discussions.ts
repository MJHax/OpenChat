import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError, readJson } from '../http';
import { getChatRow, setActiveLeaf, touchChat } from '../chats';
import { insertMessage } from '../messages';
import { checkSpend } from '../limits';
import { createDiscussion, discussionState, getDiscussionDetail, getDiscussionRow, setStatus, setTurnLimit } from '../discussion/store';
import { streamTurn } from '../discussion/turn';
import { summarizeDiscussion } from '../discussion/summary';
import { renderReport, REPORT_CSP } from '../discussion/report';
import { displayNameOf } from '../library';
import { MAX_TURN_LIMIT } from '../../../shared/discussion';
import type { NewDiscussion } from '../../../shared/types';

const MAX_HOST_MESSAGE = 20_000;

export function discussionRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();
  // Discussions with a turn streaming: a second turn or a host message would land in the middle of it.
  const inFlight = new Set<string>();

  r.post('/', async (c) => c.json(createDiscussion(db, await readJson<NewDiscussion>(c)), 201));

  r.get('/:id', (c) => c.json(getDiscussionDetail(db, c.req.param('id'))));

  /** One turn. A reached spending limit refuses it before anything is saved; a turn already running is never stopped. */
  r.post('/:id/turn', (c) => {
    const id = c.req.param('id');
    const discussion = getDiscussionRow(db, id);
    checkSpend(db);
    if (inFlight.has(id)) throw new HttpError(409, 'A turn is still running in this discussion.');
    if (discussion.status === 'ended') throw new HttpError(409, 'This discussion has ended. Add turns to continue.');
    inFlight.add(id);
    try {
      return streamTurn(c, deps, id, () => inFlight.delete(id));
    } catch (err) {
      inFlight.delete(id);
      throw err;
    }
  });

  /** A host line. It never starts a turn itself; the client asks for the next turn if the discussion is running. */
  r.post('/:id/messages', async (c) => {
    const id = c.req.param('id');
    getDiscussionRow(db, id);
    const body = await readJson<{ content?: unknown }>(c);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new HttpError(400, 'Message is empty.');
    if (content.length > MAX_HOST_MESSAGE) throw new HttpError(400, 'That message is too long.');
    if (inFlight.has(id)) throw new HttpError(409, 'Wait for the current turn to finish.');
    const message = insertMessage(db, { chatId: id, parentId: getChatRow(db, id)?.active_leaf_id ?? null, role: 'user', content });
    setActiveLeaf(db, id, message.id);
    touchChat(db, id);
    return c.json(message, 201);
  });

  r.post('/:id/summary', async (c) => {
    const id = c.req.param('id');
    getDiscussionRow(db, id);
    const body = await readJson<{ modelId?: unknown }>(c);
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) throw new HttpError(400, 'Pick a model first.');
    if (inFlight.has(id)) throw new HttpError(409, 'Wait for the current turn to finish.');
    return c.json(await summarizeDiscussion(deps, id, body.modelId.trim()));
  });

  r.get('/:id/report', (c) => {
    const detail = getDiscussionDetail(db, c.req.param('id'));
    const ids = new Set([...detail.participants.map((p) => p.modelId), ...(detail.summary ? [detail.summary.modelId] : [])]);
    const modelNames = Object.fromEntries([...ids].map((m) => [m, displayNameOf(db, m)]));
    c.header('Content-Security-Policy', REPORT_CSP);
    return c.html(renderReport(detail, { generatedAt: Date.now(), modelNames }));
  });

  r.post('/:id/stop', (c) => {
    const id = c.req.param('id');
    getDiscussionRow(db, id);
    setStatus(db, id, 'ended', 'stopped');
    return c.json(discussionState(db, id));
  });

  /** Two more turns: on top of the limit while active, or exactly two from now on an ended discussion. */
  r.post('/:id/more-turns', (c) => {
    const id = c.req.param('id');
    const discussion = getDiscussionRow(db, id);
    const state = discussionState(db, id);
    const limit = discussion.status === 'active' ? state.turnLimit + 2 : state.turnsTaken + 2;
    if (limit > MAX_TURN_LIMIT) throw new HttpError(400, `This discussion has reached the ${MAX_TURN_LIMIT}-turn maximum.`);
    db.transaction(() => {
      setTurnLimit(db, id, limit);
      if (discussion.status === 'ended') setStatus(db, id, 'active', null);
    })();
    return c.json(discussionState(db, id));
  });

  return r;
}
