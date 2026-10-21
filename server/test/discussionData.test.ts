import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { readZip } from './zipReader';
import { newDiscussion, seedModel } from './discussionHelpers';
import type { OpenRouterClient, StreamEvent } from '../src/openrouter';
import type { DiscussionDetail, StatsResponse, StorageUsage } from '../../shared/types';

const USAGE = { promptTokens: 1, completionTokens: 2, cost: 0.002, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null };

/** An app holding one chat with a reply and one discussion with one turn, a host line and a summary. */
async function seeded() {
  const streamChat: OpenRouterClient['streamChat'] = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'delta', text: 'The egg came first.' };
    yield { type: 'usage', usage: USAGE };
  };
  const app = makeApp({ streamChat, complete: async () => 'They argued about eggs.' });
  seedModel(app.db, 'test/tools', true);
  const chatId = (await (await app.call('POST', '/api/chats')).json()).id as string;
  await readEvents(await app.call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'test/tools' }));
  const d = (await (await app.call('POST', '/api/discussions', newDiscussion())).json()) as DiscussionDetail;
  await readEvents(await app.call('POST', `/api/discussions/${d.chat.id}/turn`));
  await app.call('POST', `/api/discussions/${d.chat.id}/messages`, { content: 'Nice.' });
  await app.call('POST', `/api/discussions/${d.chat.id}/summary`, { modelId: 'test/tools' });
  return { ...app, chatId, discussionId: d.chat.id };
}

const remove = (call: ReturnType<typeof makeApp>['call'], target: string) => call('POST', '/api/data/delete', { target, confirm: 'DELETE' });
const ids = async (call: ReturnType<typeof makeApp>['call'], kind: string) =>
  ((await (await call('GET', `/api/chats?kind=${kind}`)).json()) as { id: string }[]).map((c) => c.id);

describe('discussions in stats, the Data tab and export', () => {
  it('counts discussion replies in chat stats', async () => {
    const { call } = await seeded();
    const stats = (await (await call('GET', '/api/stats?range=all&tz=UTC')).json()) as StatsResponse;
    expect(stats.tiles.replies).toBe(2);
  });

  it('deletes all discussions without touching chats', async () => {
    const { call, chatId, discussionId } = await seeded();
    const res = await (await remove(call, 'discussions')).json();
    expect(res).toEqual({ ok: true, chatIds: [discussionId] });
    expect(await ids(call, 'discussion')).toEqual([]);
    expect(await ids(call, 'chat')).toEqual([chatId]);
  });

  it('delete chats leaves discussions', async () => {
    const { call, discussionId } = await seeded();
    await remove(call, 'chats');
    expect(await ids(call, 'discussion')).toEqual([discussionId]);
  });

  it('splits discussion text into its own storage part', async () => {
    const { call, discussionId } = await seeded();
    const before = (await (await call('GET', '/api/data/storage')).json()) as StorageUsage;
    const textBytes = Buffer.byteLength('The egg came first.') + Buffer.byteLength('Nice.');
    expect(before.parts.discussions).toBe(textBytes);
    expect(before.parts.messages).toBe(Buffer.byteLength('Hi') + Buffer.byteLength('The egg came first.'));
    expect(before.total).toBe(Object.values(before.parts).reduce((a, b) => a + b, 0));
    expect(discussionId).toBeTruthy();
  });

  it('exports a discussion with speaker names and its summary', async () => {
    const { call, db } = await seeded();
    const files = readZip(Buffer.from(await (await call('GET', '/api/data/export')).arrayBuffer()));
    const name = [...files.keys()].find((n) => n.startsWith('openchat-export/discussions/'));
    expect(name).toMatch(/^openchat-export\/discussions\/Which came first, the chicken or the egg-[0-9a-f]{8}\.md$/);
    const md = files.get(name!)!.toString();
    expect(md).toContain('**Egg-Defender** (test/tools): The egg came first.');
    expect(md).toContain('**Host**: Nice.');
    expect(md).toMatch(/## Summary\n\nThey argued about eggs\.\n$/);
    const data = JSON.parse(files.get('openchat-export/data.json')!.toString());
    expect(data.discussions).toHaveLength(1);
    expect(data.discussionParticipants).toHaveLength(2);
    expect(db).toBeTruthy();
  });
});
