import type { NewDiscussion } from './types';

export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS = 6;
export const NAME_MAX = 40;
export const TOPIC_MAX = 500;
export const DEFAULT_TURN_LIMIT = 10;
export const MAX_TURN_LIMIT = 100;
/** What models call the person watching; no participant may use it. */
export const HOST_NAME = 'Host';

const key = (name: string) => name.trim().toLowerCase();

/** The first problem with a new discussion, as a message for the user; null when it can start. */
export function validateNewDiscussion(d: NewDiscussion, maxInstructions: number): string | null {
  if (!d.topic?.trim()) return 'Enter a topic.';
  if (d.topic.trim().length > TOPIC_MAX) return `The topic can be at most ${TOPIC_MAX} characters.`;
  if (!Number.isInteger(d.turnLimit) || d.turnLimit < 1 || d.turnLimit > MAX_TURN_LIMIT) {
    return `The turn limit must be a whole number from 1 to ${MAX_TURN_LIMIT}.`;
  }
  const people = d.participants ?? [];
  if (people.length < MIN_PARTICIPANTS || people.length > MAX_PARTICIPANTS) {
    return `A discussion needs ${MIN_PARTICIPANTS} to ${MAX_PARTICIPANTS} participants.`;
  }
  for (const p of people) {
    if (!p.name?.trim()) return 'Every participant needs a name.';
    if (p.name.trim().length > NAME_MAX) return `Names can be at most ${NAME_MAX} characters.`;
    if (key(p.name) === key(HOST_NAME)) return `"${HOST_NAME}" is reserved for you. Pick another name.`;
    if (!p.modelId?.trim()) return 'Pick a model for every participant.';
    if ((p.instructions ?? '').length > maxInstructions) {
      return `Instructions can be at most ${maxInstructions.toLocaleString('en-US')} characters.`;
    }
  }
  if (new Set(people.map((p) => key(p.name))).size !== people.length) return 'Each participant needs a different name.';
  if (people.filter((p) => p.isModerator).length > 1) return 'Only one participant can be the moderator.';
  return null;
}

/** Avatar colors by position: a light fill and the dark text that reads on it. */
export const PARTICIPANT_COLORS: { bg: string; fg: string }[] = [
  { bg: '#EEEDFE', fg: '#3C3489' },
  { bg: '#FAECE7', fg: '#712B13' },
  { bg: '#E1F5EE', fg: '#085041' },
  { bg: '#FBEAF0', fg: '#72243E' },
  { bg: '#FAEEDA', fg: '#633806' },
  { bg: '#E6F1FB', fg: '#0C447C' },
];

export const participantColor = (position: number) => PARTICIPANT_COLORS[position % PARTICIPANT_COLORS.length];
