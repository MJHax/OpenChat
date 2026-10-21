import { Hono } from 'hono';
import type { Deps } from '../app';
import { HttpError } from '../http';
import { requireChat } from '../chats';
import { loadedWindows } from '../providers';
import { estimatePath } from '../contextCheck';
import { ensurePdfText, pathPdfIds } from '../pdfText';
import { isLocalModelId } from '../../../shared/localModels';
import { getChatMessages } from '../messages';
import { activePath } from '../tree';

/**
 * GET /api/context?model=…[&chat=…][&instructions=…]: how full `model`'s window is for the chat's active path, or for
 * a new chat with draft instructions.
 */
export function contextRoutes(deps: Deps): Hono {
  const { db } = deps;
  const r = new Hono();

  r.get('/', async (c) => {
    const modelId = c.req.query('model');
    const chatId = c.req.query('chat');
    if (!modelId) throw new HttpError(400, 'model is required.');
    const chat = chatId ? requireChat(db, chatId) : null;
    const path = chat ? activePath(getChatMessages(db, chat.id), chat.active_leaf_id) : [];
    // A local model reads a PDF as text, so earlier PDFs are read now, as a send would, and the ring matches it.
    if (chat && isLocalModelId(modelId)) await ensurePdfText(db, pathPdfIds(db, chat.id, chat.active_leaf_id));
    return c.json(estimatePath(db, {
      modelId, chatId: chatId ?? null, path, instructions: c.req.query('instructions') ?? '', windows: await loadedWindows(deps, [modelId]),
    }));
  });

  return r;
}
