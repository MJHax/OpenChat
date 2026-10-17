import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError } from '../http';
import { canViewImages } from '../../../shared/attachments';
import { getAttachmentData } from '../attachments';
import { requireChat } from '../chats';
import { estimateContext } from '../context';
import { modelContextLength, modelModalities } from '../library';
import { getChatMessages } from '../messages';
import { buildSystemPrompt } from '../prompt';
import { getPersona } from '../settings';
import { activePath } from '../tree';

/** GET /api/context?model=…[&chat=…]: how full `model`'s window is for the chat's active path (or a new chat). */
export function contextRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const modelId = c.req.query('model');
    const chatId = c.req.query('chat');
    if (!modelId) throw new HttpError(400, 'model is required.');
    const path = chatId ? activePath(getChatMessages(db, chatId), requireChat(db, chatId).active_leaf_id) : [];
    return c.json(estimateContext({
      modelId,
      contextLength: modelContextLength(db, modelId),
      system: buildSystemPrompt(getPersona(db)),
      path,
      canViewImages: canViewImages(modelModalities(db, modelId)),
      loadData: (id) => getAttachmentData(db, id) ?? Buffer.alloc(0),
    }));
  });

  return r;
}
