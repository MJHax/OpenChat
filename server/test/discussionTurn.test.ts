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
const USAGE = { promptTokens: 1, completionTokens: 2, cost: 0.002, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null, loadMs: null, generationMs: null };

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
    expect((await s.call('POST', `/api/discussions/${s.id}/summary`, { modelId: 'test/cheap' })).status).toBe(409);
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
    expect(more).toEqual({ status: 'active', endReason: null, endNote: null, turnLimit: 3, turnsTaken: 1, moderatorNoteAfter: null });
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

  it('saves and replaces the summary and logs it as a summary call', async () => {
    const replies = ['First summary.', ' Second summary. '];
    const prompts: ChatMessage[][] = [];
    const fake = scripted([{ text: ['The egg.'] }]);
    const app = makeApp({
      streamChat: fake.streamChat,
      complete: async ({ messages, onUsage }) => {
        prompts.push(messages);
        onUsage?.(USAGE);
        return replies[prompts.length - 1];
      },
    });
    seedModel(app.db, 'test/tools', true);
    const d = (await (await app.call('POST', '/api/discussions', newDiscussion())).json()) as DiscussionDetail;
    await readEvents(await app.call('POST', `/api/discussions/${d.chat.id}/turn`));
    await app.call('POST', `/api/discussions/${d.chat.id}/messages`, { content: 'Thanks.' });

    const first = await (await app.call('POST', `/api/discussions/${d.chat.id}/summary`, { modelId: 'test/cheap' })).json();
    expect(first).toMatchObject({ text: 'First summary.', modelId: 'test/cheap', cost: 0.002 });
    expect(prompts[0][0]).toEqual({
      role: 'system',
      content: "Summarize this discussion for the Host. Say what each participant argued, how their positions moved over the discussion, and the outcome, if there was one. Use the participants' names. Keep it under 300 words.",
    });
    expect(prompts[0][1]).toEqual({
      role: 'user', content: 'Topic: "Which came first, the chicken or the egg?"\n\n**Egg-Defender:** The egg.\n\n**Host:** Thanks.',
    });

    await app.call('POST', `/api/discussions/${d.chat.id}/summary`, { modelId: 'test/cheap' });
    const detail = (await (await app.call('GET', `/api/discussions/${d.chat.id}`)).json()) as DiscussionDetail;
    expect(detail.summary?.text).toBe('Second summary.');
    const rows = loadUsageRows(app.db, null).filter((r) => r.purpose === 'summary');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ chatId: d.chat.id, threadKind: 'discussion', modelId: 'test/cheap' });
  });

  it('refuses an empty summary', async () => {
    const app = makeApp({ complete: async () => '  ' });
    seedModel(app.db, 'test/tools', true);
    const d = (await (await app.call('POST', '/api/discussions', newDiscussion())).json()) as DiscussionDetail;
    const res = await app.call('POST', `/api/discussions/${d.chat.id}/summary`, { modelId: 'test/cheap' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The model returned an empty summary. Try again or pick another model.' });
  });

  it('ends at the limit when the last allowed turn fails with a partial, and refuses another', async () => {
    const s = await setup([{ text: ['The eg'], fail: new OpenRouterError('The model provider returned an error.', 502) }], newDiscussion({ turnLimit: 1 }));
    const { events } = await s.turn();
    expect(ev(events, 'error').state).toMatchObject({ status: 'ended', endReason: 'limit', turnsTaken: 1 });
    expect(await s.turn()).toMatchObject({ status: 409, error: 'This discussion has ended. Add turns to continue.' });
    expect(s.calls).toHaveLength(1);
  });

  it('refuses a turn on an active discussion that has already used its turns', async () => {
    const s = await setup([], newDiscussion({ turnLimit: 1 }));
    await s.turn();
    s.db.prepare("UPDATE discussions SET status = 'active', end_reason = NULL").run();
    expect(await s.turn()).toMatchObject({ status: 409, error: 'This discussion has ended. Add turns to continue.' });
    expect((await s.detail()).state).toMatchObject({ status: 'ended', endReason: 'limit' });
    expect(s.calls).toHaveLength(1);
  });

  it('cleans a stopped partial like a finished reply', async () => {
    const s = await setup([{ text: ['The egg.\n**Chicken-Defender:** No!'], fail: new OpenRouterError('The model provider returned an error.', 502) }]);
    const { events } = await s.turn();
    expect(ev(events, 'error').partial.content).toBe('The egg.');
  });

  it('keeps the stop reason when a turn finishes after Stop', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const s = await setup([{ text: ['Last words'], hold }], newDiscussion({ turnLimit: 1 }));
    const running = s.call('POST', `/api/discussions/${s.id}/turn`);
    await new Promise((r) => setTimeout(r, 20));
    await s.call('POST', `/api/discussions/${s.id}/stop`);
    release();
    const events = await readEvents(await running);
    expect(ev(events, 'done').state).toMatchObject({ status: 'ended', endReason: 'stopped' });
  });

  it('records usage with threadKind discussion', async () => {
    const s = await setup([]);
    const { events } = await s.turn();
    const rows = loadUsageRows(s.db, null).filter((r) => r.chatId === s.id);
    expect(rows).toEqual([expect.objectContaining({
      purpose: 'reply', kind: 'send', threadKind: 'discussion', messageId: ev(events, 'done').message.id, status: 'complete', cost: 0.002,
    })]);
  });

  describe("moderator note", () => {
    const PASS = { name: "pass_to", arguments: "{\"name\":\"Chicken-Defender\"}" };
    const BAD = { name: "pass_to", arguments: "{\"name\":\"Nobody\"}" };
    const END = { name: "end_discussion", arguments: "{\"reason\":\"Done.\"}" };
    const MISS: Turn = { text: ["Hmm."] };
    const OTHER: Turn = { text: ["A point."] };

    /** Runs `n` turns and returns each done frame. */
    async function run(s: Awaited<ReturnType<typeof setup>>, n: number) {
      const done = [];
      for (let i = 0; i < n; i++) done.push(ev((await s.turn()).events, "done"));
      return done;
    }

    it("notes the moderator turn that made two misses in a row", async () => {
      const s = await setup([MISS, OTHER, MISS], withModerator());
      const [first, , second] = await run(s, 3);
      expect(first.state.moderatorNoteAfter).toBeNull();
      expect(second.state.moderatorNoteAfter).toBe(second.message.id);
      expect((await s.detail()).state.moderatorNoteAfter).toBe(second.message.id);
    });

    it("counts a pass_to with an unknown name as a miss", async () => {
      const s = await setup([{ text: ["x"], tool: BAD }, OTHER, { text: ["y"], tool: BAD }], withModerator());
      const done = await run(s, 3);
      expect(done[2].state.moderatorNoteAfter).toBe(done[2].message.id);
    });

    it("a valid pass_to between two misses means no note", async () => {
      const s = await setup([MISS, OTHER, { text: ["go"], tool: PASS }, OTHER, MISS], withModerator());
      const done = await run(s, 5);
      expect(done[4].state.moderatorNoteAfter).toBeNull();
    });

    it("end_discussion resets the count, and more-turns does not bring it back", async () => {
      const s = await setup([MISS, OTHER, { text: ["done"], tool: END }, OTHER, MISS], withModerator());
      await run(s, 3);
      await s.call("POST", `/api/discussions/${s.id}/more-turns`);
      const done = await run(s, 2);
      expect(done[1].state.moderatorNoteAfter).toBeNull();
    });

    it("keeps the note on the second miss when a third follows", async () => {
      const s = await setup([MISS, OTHER, MISS, OTHER, MISS], withModerator());
      const done = await run(s, 5);
      expect(done[4].state.moderatorNoteAfter).toBe(done[2].message.id);
    });

    it("a moderator turn that fails mid-stream leaves the count alone", async () => {
      const s = await setup([MISS, OTHER, { text: ["The"], fail: new OpenRouterError("Bad.", 502) }, OTHER, MISS], withModerator());
      await run(s, 2);
      const failed = ev((await s.turn()).events, "error");
      expect(failed.state.moderatorNoteAfter).toBeNull();
      const done = await run(s, 2);
      expect(done[1].state.moderatorNoteAfter).toBe(done[1].message.id);
    });
  });
});
