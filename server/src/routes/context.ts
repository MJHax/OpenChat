import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError } from '../http';
import { canViewImages } from '../../../shared/attachments';
import { chatImageNames, getAttachmentData } from '../attachments';
import { collapseSuperseded } from '../../../shared/files';
import { requireChat } from '../chats';
import { estimateContext } from '../context';
import { modelContextLength, modelModalities } from '../library';
import { getChatMessages } from '../messages';
import { replySystemPrompt } from '../prompt';
import { chatPersona } from '../settings';
import { activePath } from '../tree';

/**
 * GET /api/context?model=…[&chat=…][&instructions=…]: how full `model`'s window is for the chat's active path, or for
 * a new chat with draft instructions.
 */
export function contextRoutes({ db }: Deps): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const modelId = c.req.query('model');
    const chatId = c.req.query('chat');
    if (!modelId) throw new HttpError(400, 'model is required.');
    const chat = chatId ? requireChat(db, chatId) : null;
    const path = chat ? activePath(getChatMessages(db, chat.id), chat.active_leaf_id) : [];
    // What the model is actually sent: older versions of a file are reduced to a stub.
    const sent = collapseSuperseded(path);
    return c.json(estimateContext({
      modelId,
      contextLength: modelContextLength(db, modelId),
      system: replySystemPrompt(chatPersona(db, chatId ?? null, c.req.query('instructions') ?? ''), chatId ? chatImageNames(db, chatId) : []),
      note: chat?.context_note ?? null,
      path: path.map((m, i) => ({ ...m, content: sent[i] })),
      canViewImages: canViewImages(modelModalities(db, modelId)),
      loadData: (id) => getAttachmentData(db, id) ?? Buffer.alloc(0),
    }));
  });

  return r;
}
