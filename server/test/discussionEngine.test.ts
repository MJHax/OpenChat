import { describe, it, expect } from 'vitest';
import {
  buildDiscussionPrompt, cleanReply, matchParticipant, moderatorTools, nextSpeaker, readToolCall, turnsTaken,
} from '../src/discussion/engine';
import type { DiscussionParticipant, Message } from '../../shared/types';

const P = (id: string, position: number, name: string, isModerator = false, instructions = ''): DiscussionParticipant =>
  ({ id, position, name, modelId: 'openai/gpt-4o', instructions, isModerator });
const egg = P('egg', 0, 'Egg-Defender', false, 'Argue that the egg came first.');
const chicken = P('chicken', 1, 'Chicken-Defender', false, 'Argue that the chicken came first.');
const mod = P('mod', 2, 'Moderator', true, 'Keep it fair.');
const rotation = [egg, chicken];
const moderated = [egg, chicken, mod];

let n = 0;
const say = (who: DiscussionParticipant | null, content: string, handoffTo: string | null = null): Message => ({
  id: `m${n++}`, chatId: 'c', parentId: null, role: who ? 'assistant' : 'user', content, modelId: who?.modelId ?? null,
  promptTokens: null, completionTokens: null, cost: null, status: 'complete', createdAt: n, attachments: [], webSearch: false,
  sources: [], webSearches: null, participantId: who?.id ?? null, handoffTo, effort: null,
});
const host = (content: string) => say(null, content);

describe('matchParticipant', () => {
  it('matches names trimmed and case-insensitively', () => {
    expect(matchParticipant(moderated, ' egg-defender ')?.id).toBe('egg');
    expect(matchParticipant(moderated, 'CHICKEN-DEFENDER')?.id).toBe('chicken');
    expect(matchParticipant(moderated, 'Egg Defender')).toBeUndefined();
  });
});

describe('nextSpeaker', () => {
  it('starts rotation at position 0 and wraps around', () => {
    expect(nextSpeaker(rotation, []).id).toBe('egg');
    expect(nextSpeaker(rotation, [say(egg, 'a')]).id).toBe('chicken');
    expect(nextSpeaker(rotation, [say(egg, 'a'), say(chicken, 'b')]).id).toBe('egg');
  });

  it('does not move the rotation for host messages', () => {
    expect(nextSpeaker(rotation, [say(egg, 'a'), host('wrap it up')]).id).toBe('chicken');
  });

  it('lets the moderator open and speak after every other turn', () => {
    expect(nextSpeaker(moderated, []).id).toBe('mod');
    expect(nextSpeaker(moderated, [say(mod, 'Egg first', 'egg'), say(egg, 'a')]).id).toBe('mod');
    expect(nextSpeaker(moderated, [say(mod, '', 'egg'), say(egg, 'a'), host('hi')]).id).toBe('mod');
  });

  it('applies a valid moderator handoff', () => {
    expect(nextSpeaker(moderated, [say(mod, 'Chicken, go', 'chicken')]).id).toBe('chicken');
  });

  it('falls back to rotation when the moderator hands the floor to itself or an unknown name', () => {
    expect(nextSpeaker(moderated, [say(mod, 'hm', null)]).id).toBe('egg');
    expect(nextSpeaker(moderated, [say(mod, '', 'mod')]).id).toBe('egg');
    expect(nextSpeaker(moderated, [say(mod, '', 'egg'), say(egg, 'a'), say(mod, '', 'nobody')]).id).toBe('chicken');
  });
});

describe('turnsTaken', () => {
  it('counts an empty non-moderator reply as a turn but not a silent moderator handoff', () => {
    expect(turnsTaken(moderated, [say(egg, ''), say(mod, '', 'chicken')])).toBe(1);
    expect(turnsTaken(moderated, [say(mod, 'Welcome', 'egg'), say(egg, 'a'), host('x')])).toBe(2);
  });
});

describe('readToolCall', () => {
  it('reads a handoff to a non-moderator by name', () => {
    expect(readToolCall(moderated, { name: 'pass_to', arguments: '{"name":" egg-defender"}' })).toEqual({ handoffTo: 'egg' });
  });

  it('ignores the moderator itself, unknown names and malformed arguments', () => {
    expect(readToolCall(moderated, { name: 'pass_to', arguments: '{"name":"Moderator"}' })).toBeNull();
    expect(readToolCall(moderated, { name: 'pass_to', arguments: '{"name":"Nobody"}' })).toBeNull();
    expect(readToolCall(moderated, { name: 'pass_to', arguments: '{"name":' })).toBeNull();
    expect(readToolCall(moderated, { name: 'dance', arguments: '{}' })).toBeNull();
  });

  it('reads an end with its reason, or a default one', () => {
    expect(readToolCall(moderated, { name: 'end_discussion', arguments: '{"reason":" They agreed. "}' })).toEqual({ end: 'They agreed.' });
    expect(readToolCall(moderated, { name: 'end_discussion', arguments: '{}' })).toEqual({ end: 'The moderator ended the discussion.' });
  });
});

describe('moderatorTools', () => {
  it('offers pass_to with the non-moderator names and end_discussion', () => {
    expect(moderatorTools(moderated)).toEqual([
      {
        name: 'pass_to', description: 'Give the floor to the next speaker.',
        parameters: { type: 'object', properties: { name: { type: 'string', enum: ['Egg-Defender', 'Chicken-Defender'] } }, required: ['name'] },
      },
      {
        name: 'end_discussion', description: 'End the discussion.',
        parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      },
    ]);
  });
});

describe('cleanReply', () => {
  const others = ['Chicken-Defender', 'Moderator'];
  it('drops a leading own-name label', () => {
    expect(cleanReply('**Egg-Defender:** The egg.', 'Egg-Defender', others)).toBe('The egg.');
    expect(cleanReply('  **egg-defender**: The egg.', 'Egg-Defender', others)).toBe('The egg.');
    expect(cleanReply('Egg-Defender: The egg.', 'Egg-Defender', others)).toBe('The egg.');
  });

  it('cuts where the reply starts writing someone else', () => {
    expect(cleanReply('The egg.\n\n**Chicken-Defender:** No!', 'Egg-Defender', others)).toBe('The egg.');
    expect(cleanReply('The egg.\nHost: thanks', 'Egg-Defender', others)).toBe('The egg.');
  });

  it('leaves other text alone', () => {
    expect(cleanReply('As Chicken-Defender: said, eggs.', 'Egg-Defender', others)).toBe('As Chicken-Defender: said, eggs.');
  });
});

describe('buildDiscussionPrompt', () => {
  const topic = 'Which came first, the chicken or the egg?';

  it('tells the speaker who it is, who is in the room and its own instructions', () => {
    const [system] = buildDiscussionPrompt(topic, moderated, [], egg);
    expect(system).toEqual({
      role: 'system',
      content: [
        `You are Egg-Defender. You're in a discussion with Chicken-Defender and Moderator about: "${topic}". The person watching is the Host, who may step in.`,
        'Argue that the egg came first.',
        "Write only your own reply. Don't write lines for anyone else, and don't start with your name.",
      ].join('\n\n'),
    });
  });

  it('adds the moderator paragraph for the moderator', () => {
    const [system] = buildDiscussionPrompt(topic, moderated, [], mod);
    expect(system.content).toContain('You are the moderator. After you speak, call pass_to with the name of who should speak next, or call end_discussion if the discussion is finished. You may call pass_to without saying anything.');
    expect(system.content).toContain('with Egg-Defender and Chicken-Defender about');
  });

  it('joins three or more names with commas and "and"', () => {
    const extra = [...moderated, P('analyst', 3, 'Analyst')];
    expect(buildDiscussionPrompt(topic, extra, [], egg)[0].content).toContain('with Chicken-Defender, Moderator and Analyst about');
  });

  it('starts the discussion when there are no messages', () => {
    expect(buildDiscussionPrompt(topic, rotation, [], egg).slice(1)).toEqual([
      { role: 'user', content: "The discussion is starting. It's your turn, Egg-Defender." },
    ]);
  });

  it('labels what others said since the last turn and ends with the cue', () => {
    const messages = [say(egg, 'The egg.'), say(chicken, 'The chicken.'), host('Keep it short.')];
    expect(buildDiscussionPrompt(topic, rotation, messages, egg).slice(1)).toEqual([
      { role: 'user', content: 'The discussion is starting.' },
      { role: 'assistant', content: 'The egg.' },
      { role: 'user', content: "**Chicken-Defender:** The chicken.\n\n**Host:** Keep it short.\n\nIt's your turn, Egg-Defender." },
    ]);
  });

  it("shows the moderator its own handoffs and others' silent ones", () => {
    const messages = [say(mod, 'Welcome.', 'egg'), say(egg, 'The egg.'), say(mod, '', 'chicken')];
    expect(buildDiscussionPrompt(topic, moderated, messages, mod).slice(1)).toEqual([
      { role: 'user', content: 'The discussion is starting.' },
      { role: 'assistant', content: 'Welcome.\n\n(You passed the floor to Egg-Defender.)' },
      { role: 'user', content: '**Egg-Defender:** The egg.' },
      { role: 'assistant', content: '(You passed the floor to Chicken-Defender.)' },
      { role: 'user', content: "It's your turn, Moderator." },
    ]);
    expect(buildDiscussionPrompt(topic, moderated, messages, chicken).at(-1)).toEqual({
      role: 'user',
      content: "**Moderator:** Welcome.\n\n**Egg-Defender:** The egg.\n\n_Moderator passed the floor to Chicken-Defender._\n\nIt's your turn, Chicken-Defender.",
    });
  });

  it('never sees other participants instructions', () => {
    const prompt = JSON.stringify(buildDiscussionPrompt(topic, moderated, [say(chicken, 'x')], egg));
    expect(prompt).not.toContain(chicken.instructions);
    expect(prompt).not.toContain(mod.instructions);
  });

  it('keeps user/assistant alternation', () => {
    const messages = [say(mod, 'Hi', 'egg'), say(egg, 'a'), host('h1'), host('h2'), say(mod, '', 'chicken'), say(chicken, 'b'), say(mod, 'ok', 'egg')];
    for (const speaker of moderated) {
      const roles = buildDiscussionPrompt(topic, moderated, messages, speaker).slice(1).map((m) => m.role);
      expect(roles[0]).toBe('user');
      expect(roles.at(-1)).toBe('user');
      roles.forEach((r, i) => i > 0 && expect(r).not.toBe(roles[i - 1]));
    }
  });
});
