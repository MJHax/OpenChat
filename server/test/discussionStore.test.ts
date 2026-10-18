import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createChat } from '../src/chats';
import { insertMessage } from '../src/messages';

describe('discussion messages', () => {
  it('insertMessage round-trips participantId and handoffTo', () => {
    const db = openDb(':memory:');
    const chat = createChat(db, 'discussion');
    const plain = insertMessage(db, { chatId: chat.id, parentId: null, role: 'user', content: 'hi' });
    expect(plain).toMatchObject({ participantId: null, handoffTo: null });
    const turn = insertMessage(db, {
      chatId: chat.id, parentId: plain.id, role: 'assistant', content: '', participantId: 'p-mod', handoffTo: 'p-egg',
    });
    expect(turn).toMatchObject({ participantId: 'p-mod', handoffTo: 'p-egg' });
  });
});
