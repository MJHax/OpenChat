import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { insertMessage } from '../src/messages';
import { attachToMessage, getAttachmentData, getAttachmentRow, hashBytes } from '../src/attachments';
import { setActiveLeaf } from '../src/chats';
import type { Attachment, ChatDetail, ChatSummary } from '../../shared/types';

const detailOf = async (call: ReturnType<typeof makeApp>['call'], id: string) => (await (await call('GET', `/api/chats/${id}`)).json()) as ChatDetail;

/** u1 → a1 → u2 → a2, plus a1b, a second version of the first reply; u1 carries a file. */
async function branchedChat(ctx: ReturnType<typeof makeApp>) {
  const chat = (await (await ctx.call('POST', '/api/chats', { instructions: 'Be brief.' })).json()) as ChatSummary;
  const file = (await (await ctx.upload('notes', 'notes.md')).json()) as Attachment;
  const u1 = insertMessage(ctx.db, { chatId: chat.id, parentId: null, role: 'user', content: 'Read this' });
  attachToMessage(ctx.db, u1.id, [getAttachmentRow(ctx.db, file.id)!]);
  const a1 = insertMessage(ctx.db, { chatId: chat.id, parentId: u1.id, role: 'assistant', content: 'Read it.', modelId: 'm/x', cost: 0.01 });
  insertMessage(ctx.db, { chatId: chat.id, parentId: u1.id, role: 'assistant', content: 'Other version.', modelId: 'm/y' });
  const u2 = insertMessage(ctx.db, { chatId: chat.id, parentId: a1.id, role: 'user', content: 'Now summarize' });
  const a2 = insertMessage(ctx.db, { chatId: chat.id, parentId: u2.id, role: 'assistant', content: 'Summary.', modelId: 'm/x' });
  setActiveLeaf(ctx.db, chat.id, a2.id);
  return { chat, file, a1, a2 };
}

describe('POST /api/chats/:id/fork', () => {
  it('keeps the lost-context mark on copied replies', async () => {
    const ctx = makeApp();
    const { chat, a1 } = await branchedChat(ctx);
    ctx.db.prepare('UPDATE messages SET context_dropped = 1 WHERE id = ?').run(a1.id);
    const created = (await (await ctx.call('POST', `/api/chats/${chat.id}/fork`, { messageId: a1.id })).json()) as ChatSummary;
    const fork = await detailOf(ctx.call, created.id);
    expect(fork.messages[1].contextDropped).toBe(true);
  });

  it('copies the path up to the message into a new chat, with files and instructions', async () => {
    const ctx = makeApp();
    const { chat, file, a1 } = await branchedChat(ctx);

    const res = await ctx.call('POST', `/api/chats/${chat.id}/fork`, { messageId: a1.id });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ChatSummary;
    expect(created.title).toBe('New chat (fork)');

    const fork = await detailOf(ctx.call, created.id);
    expect(fork.chat.instructions).toBe('Be brief.');
    expect(fork.messages.map((m) => [m.role, m.content, m.modelId])).toEqual([['user', 'Read this', null], ['assistant', 'Read it.', 'm/x']]);
    expect(fork.messages[1].cost).toBe(0.01);
    expect(fork.messages[1].siblingIds).toHaveLength(1); // the other version stays behind
    expect(fork.chat.activeLeafId).toBe(fork.messages[1].id);

    const copied = fork.messages[0].attachments[0];
    expect(copied).toMatchObject({ filename: 'notes.md', kind: file.kind });
    expect(copied.id).not.toBe(file.id);
    expect(getAttachmentData(ctx.db, copied.id)?.toString()).toBe('notes');
    const hashOf = (id: string) => (ctx.db.prepare('SELECT hash FROM attachments WHERE id = ?').get(id) as { hash: string | null }).hash;
    expect(hashOf(copied.id)).toBe(hashBytes(new TextEncoder().encode('notes')));
  });

  it('leaves the original chat as it was, and the copy survives its deletion', async () => {
    const ctx = makeApp();
    const { chat, a2 } = await branchedChat(ctx);
    const before = await detailOf(ctx.call, chat.id);
    const created = (await (await ctx.call('POST', `/api/chats/${chat.id}/fork`, { messageId: a2.id })).json()) as ChatSummary;

    expect(await detailOf(ctx.call, chat.id)).toEqual(before);
    await ctx.call('DELETE', `/api/chats/${chat.id}`);
    const fork = await detailOf(ctx.call, created.id);
    expect(fork.messages.map((m) => m.content)).toEqual(['Read this', 'Read it.', 'Now summarize', 'Summary.']);
    expect(fork.messages[0].attachments).toHaveLength(1);
  });

  it('refuses a message from another chat', async () => {
    const ctx = makeApp();
    const { a1 } = await branchedChat(ctx);
    const other = (await (await ctx.call('POST', '/api/chats')).json()) as ChatSummary;
    expect((await ctx.call('POST', `/api/chats/${other.id}/fork`, { messageId: a1.id })).status).toBe(400);
    expect((await ctx.call('POST', `/api/chats/${other.id}/fork`, {})).status).toBe(400);
  });
});
