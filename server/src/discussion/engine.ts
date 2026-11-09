import type { FunctionTool } from '../openrouter';
import { withCacheMarkers, type ChatMessage } from '../prompt';
import { HOST_NAME } from '../../../shared/discussion';
import type { DiscussionParticipant, Message } from '../../../shared/types';

const key = (name: string) => name.trim().toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byPosition = (participants: DiscussionParticipant[]) => [...participants].sort((a, b) => a.position - b.position);

/** The participant called `name`: trimmed, case-insensitive; undefined when none. */
export function matchParticipant(participants: DiscussionParticipant[], name: string): DiscussionParticipant | undefined {
  return participants.find((p) => key(p.name) === key(name));
}

const isSilentModerator = (participants: DiscussionParticipant[], m: Message) =>
  !m.content.trim() && participants.some((p) => p.id === m.participantId && p.isModerator);

/** Spoken turns: every participant message except a moderator's with no text. */
export function turnsTaken(participants: DiscussionParticipant[], messages: Message[]): number {
  return messages.filter((m) => m.participantId !== null && !isSilentModerator(participants, m)).length;
}

/** The participant after the last of `pool` who spoke, wrapping around; the first of `pool` when none has. */
function rotate(pool: DiscussionParticipant[], messages: Message[]): DiscussionParticipant {
  const ids = pool.map((p) => p.id);
  const last = messages.findLast((m) => m.participantId !== null && ids.includes(m.participantId));
  return last ? pool[(ids.indexOf(last.participantId!) + 1) % pool.length] : pool[0];
}

/** Who speaks next, given the transcript so far (oldest first). */
export function nextSpeaker(participants: DiscussionParticipant[], messages: Message[]): DiscussionParticipant {
  const ordered = byPosition(participants);
  const moderator = ordered.find((p) => p.isModerator);
  if (!moderator) return rotate(ordered, messages);
  const others = ordered.filter((p) => !p.isModerator);
  const last = messages.at(-1);
  // The moderator decides after every other turn and after host messages; its handoff picks the turn after its own.
  if (last?.participantId !== moderator.id) return moderator;
  return others.find((p) => p.id === last.handoffTo) ?? rotate(others, messages);
}

/** A handoff note a model wrote itself, copying how handoffs are narrated: "(You passed the floor to Ben.)" or "_Moderator passed the floor to Ben._". */
const HANDOFF_NOTE = /\([^()\n]*passed the floor to[^()\n]*\)|_[^_\n]*passed the floor to[^_\n]*_/gi;

/** Drops a leading own-name label, anything from the first line that labels someone else, and handoff notes. */
export function cleanReply(text: string, speaker: string, others: string[]): string {
  const own = new RegExp(`^\\s*(?:\\*\\*\\s*)?${escape(speaker)}(?:\\s*\\*\\*)?\\s*:(?:\\s*\\*\\*)?\\s*`, 'i');
  const names = [...others, HOST_NAME].map(escape).join('|');
  const someoneElse = new RegExp(`\\n\\s*(?:\\*\\*\\s*)?(?:${names})(?:\\s*\\*\\*)?\\s*:`, 'i');
  const rest = text.replace(own, '');
  const cut = rest.search(someoneElse);
  return (cut === -1 ? rest : rest.slice(0, cut)).replace(HANDOFF_NOTE, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function moderatorTools(participants: DiscussionParticipant[]): FunctionTool[] {
  const names = byPosition(participants).filter((p) => !p.isModerator).map((p) => p.name);
  return [
    {
      name: 'pass_to',
      description: 'Give the floor to the next speaker.',
      parameters: { type: 'object', properties: { name: { type: 'string', enum: names } }, required: ['name'] },
    },
    {
      name: 'end_discussion',
      description: 'End the discussion.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  ];
}

/** Reads a moderator's tool call: a handoff (participant id) or an end, or null when neither is valid. */
export function readToolCall(
  participants: DiscussionParticipant[], call: { name: string; arguments: string },
): { handoffTo: string } | { end: string } | null {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    args = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
  if (call.name === 'pass_to') {
    const target = typeof args.name === 'string' ? matchParticipant(participants, args.name) : undefined;
    return target && !target.isModerator ? { handoffTo: target.id } : null;
  }
  if (call.name === 'end_discussion') {
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    return { end: reason || 'The moderator ended the discussion.' };
  }
  return null;
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

function systemPrompt(topic: string, participants: DiscussionParticipant[], speaker: DiscussionParticipant): string {
  const others = byPosition(participants).filter((p) => p.id !== speaker.id).map((p) => p.name);
  const paragraphs = [
    `You are ${speaker.name}. You're in a discussion with ${listNames(others)} about: "${topic}". The person watching is the ${HOST_NAME}, who may step in.`,
    speaker.instructions.trim(),
    speaker.isModerator
      ? 'You are the moderator. After you speak, call pass_to with the name of who should speak next, or call end_discussion if the discussion is finished. You may call pass_to without saying anything.'
      : '',
    "Write only your own reply. Don't write lines for anyone else, and don't start with your name.",
  ];
  return paragraphs.filter(Boolean).join('\n\n');
}

/**
 * The prompt for `speaker`'s next turn. Its own turns are its assistant messages; everything said since then by others
 * (participants, the moderator, the host) is one labelled user message, so user and assistant always alternate.
 */
export function buildDiscussionPrompt(
  topic: string, participants: DiscussionParticipant[], messages: Message[], speaker: DiscussionParticipant,
): ChatMessage[] {
  const nameOf = (id: string | null) => participants.find((p) => p.id === id)?.name;
  const out: ChatMessage[] = [{ role: 'system', content: systemPrompt(topic, participants, speaker) }];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) out.push({ role: 'user', content: pending.join('\n\n') });
    pending = [];
  };

  for (const m of messages) {
    const text = m.content.trim();
    const handoff = nameOf(m.handoffTo);
    if (m.participantId === speaker.id) {
      // Its own turns hold only what it said: a model copies patterns from its past replies, so a handoff note there
      // ends up written into later replies. Handoffs are narrated in the next user message instead.
      if (text || !handoff) {
        flush();
        if (out.length === 1) out.push({ role: 'user', content: 'The discussion is starting.' });
        out.push({ role: 'assistant', content: text || '(You said nothing.)' });
      }
      if (handoff) pending.push(`_You passed the floor to ${handoff}._`);
    } else if (m.participantId === null) {
      pending.push(`**${HOST_NAME}:** ${text}`);
    } else {
      const name = nameOf(m.participantId) ?? 'Someone';
      if (text) pending.push(`**${name}:** ${text}`);
      else if (handoff) pending.push(`_${name} passed the floor to ${handoff}._`);
      else pending.push(`_${name} said nothing._`);
    }
  }

  const cue = `It's your turn, ${speaker.name}.`;
  pending.push(messages.length === 0 ? `The discussion is starting. ${cue}` : cue);
  flush();
  return withCacheMarkers(speaker.modelId, out);
}

export const DECISION_PROMPT =
  'Who should speak next? Call pass_to with their name, or end_discussion if the discussion is finished. If you cannot call a tool, reply with only their name, or END.';

/** The moderator's prompt plus its own reply, then a direct question: who speaks next? Used when a turn ended with no tool call. */
export function buildDecisionPrompt(
  topic: string, participants: DiscussionParticipant[], messages: Message[], speaker: DiscussionParticipant, reply: string,
): ChatMessage[] {
  return [
    ...buildDiscussionPrompt(topic, participants, messages, speaker),
    { role: 'assistant', content: reply || '(You said nothing.)' },
    { role: 'user', content: DECISION_PROMPT },
  ];
}

/** Reads a moderator's plain-text answer to DECISION_PROMPT: a participant's name, END, or null when it is neither. */
export function readTextDecision(
  participants: DiscussionParticipant[], text: string,
): { handoffTo: string } | { end: string } | null {
  const answer = text.trim().replace(/^[*_"'`]+|[*_"'`]+$/g, '').replace(/\.$/, '').replace(/^[*_"'`]+|[*_"'`]+$/g, '').trim();
  if (answer.toLowerCase() === 'end') return { end: 'The moderator ended the discussion.' };
  const match = matchParticipant(participants, answer);
  return match && !match.isModerator ? { handoffTo: match.id } : null;
}
