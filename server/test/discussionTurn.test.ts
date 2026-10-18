import { describe, it, expect } from 'vitest';
import { makeApp, readEvents } from './appHelpers';
import { newDiscussion, seedModel, withModerator } from './discussionHelpers';
import { OpenRouterError, type OpenRouterClient, type StreamEvent } from '../src/openrouter';
import type { ChatMessage } from '../src/prompt';
import { saveLimits } from '../src/limits';
import { loadUsageRows } from '../src/usage';
import { logReply } from './usageHelpers';
import { getChatMessages } from '../src/messages';
import type { DiscussionDetail, NewDiscussion } from '../../shared/types';

type Turn = { text?: string[]; tool?: { name: string; arguments: string }; fail?: Error; hold?: Promise<void> };
const USAGE = { promptTokens: 1, completionTokens: 2, cost: 0.002, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null };

/** A fake streamChat that plays `turns` in order (then a plain reply), recording each call's prompt and tools. */
function scripted(turns: Turn[]) {
  const calls: { model: string; messages: ChatMessage[]; tools?: unknown[] }[] = [];
  const streamChat: OpenRouterClient['streamChat'] = async function* ({ model, messages, tools }): AsyncGenerator<StreamEvent> {
    calls.push({ model, messages, tools });
    const t = turns[calls.length - 1] ?? { text: [`turn ${calls.length}`] };
    for (const text of t.text ?? []) yield { type: 'delta', text };
    if (t.hold) await t.hold;
    if (t.fail) throw t.fail;
    yield { type: 'usage', usage: USAGE };
    if (t.tool) yield { type: 'tool_call', ...t.tool };
  };
  return { streamChat, calls };
}

async function setup(turns: Turn[], d: NewDiscussion = newDiscussion()) {
  const fake = scripted(turns);
  const app = makeApp({ streamChat: fake.streamChat });
  seedModel(app.db, 'test/tools', true);
  const created = (await (await app.call('POST', '/api/discussions', d)).json()) as DiscussionDetail;
  const id = created.chat.id;
  const turn = async () => {
    const res = await app.call('POST', `/api/discussions/${id}/turn`);
    return res.ok ? { status: res.status, events: await readEvents(res) } : { status: res.status, error: (await res.json()).error, events: [] };
  };
  const detail = async () => (await (await app.call('GET', `/api/discussions/${id}`)).json()) as DiscussionDetail;
  return { ...app, ...fake, id, created, turn, detail };
}

const ev = (events: { event: string; data: any }[], name: string) => events.find((e) => e.event === name)?.data;

describe('discussion turns', () => {
  it('streams a rotation turn and saves it under the speaker', async () => {
    const s = await setup([{ text: ['**Egg-Defender:** The ', 'egg.'] }]);
    const { events } = await s.turn();
    const [egg] = s.created.participants;
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(ev(events, 'start').participantId).toBe(egg.id);
    expect(ev(events, 'done').message).toMatchObject({ content: 'The egg.', participantId: egg.id, modelId: 'test/tools', cost: 0.002 });
    expect(ev(events, 'done').state).toMatchObject({ status: 'active', turnsTaken: 1 });
    expect(s.calls[0].tools).toBeUndefined();
    expect((await s.detail()).messages.map((m) => m.content)).toEqual(['The egg.']);
  });

  it('applies the moderator handoff to the next turn', async () => {
    const s = await setup([{ text: ['Chicken, go.'], tool: { name: 'pass_to', arguments: '{"name":"Chicken-Defender"}' } }], withModerator());
    const [, chicken, mod] = s.created.participants;
    const first = await s.turn();
    expect(ev(first.events, 'start').participantId).toBe(mod.id);
    expect(ev(first.events, 'done').message.handoffTo).toBe(chicken.id);
    expect(s.calls[0].tools).toHaveLength(2);
    const second = await s.turn();
    expect(ev(second.events, 'start').participantId).toBe(chicken.id);
  });

  it('ends with reason moderator and its note on end_discussion', async () => {
    const s = await setup([{ text: ['That settles it.'], tool: { name: 'end_discussion', arguments: '{"reason":"They agreed."}' } }], withModerator());
    const { events } = await s.turn();
    expect(ev(events, 'done').state).toMatchObject({ status: 'ended', endReason: 'moderator', endNote: 'They agreed.' });
  });

  it('ends with reason limit when the last allowed turn completes', async () => {
    const s = await setup([], newDiscussion({ turnLimit: 2 }));
    expect(ev((await s.turn()).events, 'done').state.status).toBe('active');
    expect(ev((await s.turn()).events, 'done').state).toMatchObject({ status: 'ended', endReason: 'limit', turnsTaken: 2 });
  });

  it('refuses a turn on an ended discussion with 409', async () => {
    const s = await setup([]);
    await s.call('POST', `/api/discussions/${s.id}/stop`);
    expect(await s.turn()).toMatchObject({ status: 409, error: 'This discussion has ended. Add turns to continue.' });
  });

  it('refuses a turn over a spending limit with 402 and saves nothing', async () => {
    const s = await setup([]);
    saveLimits(s.db, { daily: { enabled: true, amount: 1 }, weekly: { enabled: false, amount: null }, monthly: { enabled: false, amount: null }, timeZone: 'UTC' });
    logReply(s.db, { chatId: 'elsewhere', messageId: 'x', cost: 2 });
    const res = await s.turn();
    expect(res.status).toBe(402);
    expect(s.calls).toHaveLength(0);
    expect(getChatMessages(s.db, s.id)).toEqual([]);
  });

  it('saves the partial as stopped and keeps the discussion active when the stream fails', async () => {
    const s = await setup([{ text: ['The eg'], fail: new OpenRouterError('The model provider returned an error.', 502) }]);
    const { events } = await s.turn();
    const error = ev(events, 'error');
    expect(error.message).toBe('The model provider returned an error.');
    expect(error.partial).toMatchObject({ content: 'The eg', status: 'stopped' });
    expect(error.state.status).toBe('active');
  });

  it('refuses a host message and a second turn while a turn is in flight', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const s = await setup([{ text: ['Thinking'], hold }]);
    const running = s.call('POST', `/api/discussions/${s.id}/turn`);
    await new Promise((r) => setTimeout(r, 20));
    const host = await s.call('POST', `/api/discussions/${s.id}/messages`, { content: 'Wrap it up' });
    expect(host.status).toBe(409);
    expect(await host.json()).toEqual({ error: 'Wait for the current turn to finish.' });
    expect(await s.turn()).toMatchObject({ status: 409, error: 'A turn is still running in this discussion.' });
    release();
    await readEvents(await running);
    expect((await s.call('POST', `/api/discussions/${s.id}/messages`, { content: 'Wrap it up' })).status).toBe(201);
  });

  it('saves a host message on an ended discussion without starting a turn', async () => {
    const s = await setup([]);
    await s.call('POST', `/api/discussions/${s.id}/stop`);
    const res = await s.call('POST', `/api/discussions/${s.id}/messages`, { content: '  Nice work.  ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ role: 'user', content: 'Nice work.', participantId: null });
    expect(s.calls).toHaveLength(0);
    expect((await s.detail()).state.status).toBe('ended');
  });

  it('rejects an empty host message', async () => {
    const s = await setup([]);
    const res = await s.call('POST', `/api/discussions/${s.id}/messages`, { content: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Message is empty.' });
  });

  it('more-turns on an ended discussion allows exactly two more turns', async () => {
    const s = await setup([]);
    await s.turn();
    const stopped = await (await s.call('POST', `/api/discussions/${s.id}/stop`)).json();
    expect(stopped).toMatchObject({ status: 'ended', endReason: 'stopped' });
    const more = await (await s.call('POST', `/api/discussions/${s.id}/more-turns`)).json();
    expect(more).toEqual({ status: 'active', endReason: null, endNote: null, turnLimit: 3, turnsTaken: 1 });
  });

  it('more-turns while active adds two to the limit', async () => {
    const s = await setup([]);
    expect(await (await s.call('POST', `/api/discussions/${s.id}/more-turns`)).json()).toMatchObject({ status: 'active', turnLimit: 12 });
  });

  it('refuses more turns past the 100-turn maximum', async () => {
    const s = await setup([], newDiscussion({ turnLimit: 99 }));
    const res = await s.call('POST', `/api/discussions/${s.id}/more-turns`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This discussion has reached the 100-turn maximum.' });
  });

  it('records usage with threadKind discussion', async () => {
    const s = await setup([]);
    const { events } = await s.turn();
    const rows = loadUsageRows(s.db, null).filter((r) => r.chatId === s.id);
    expect(rows).toEqual([expect.objectContaining({
      purpose: 'reply', kind: 'send', threadKind: 'discussion', messageId: ev(events, 'done').message.id, status: 'complete', cost: 0.002,
    })]);
  });
});
