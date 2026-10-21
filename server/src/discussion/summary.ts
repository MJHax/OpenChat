import type { Deps } from '../app';
import { now } from '../db';
import { HttpError } from '../http';
import { checkSpend } from '../limits';
import { getChatMessages } from '../messages';
import type { Usage } from '../openrouter';
import { chatProviderOrHttp } from '../providers';
import { ProviderError } from '../providers/types';
import { recordUsage, type UsageStatus } from '../usage';
import { getDiscussionRow, getParticipants, saveSummary } from './store';
import { HOST_NAME } from '../../../shared/discussion';
import type { DiscussionParticipant, DiscussionSummary, Message } from '../../../shared/types';

const SUMMARY_PROMPT =
  "Summarize this discussion for the Host. Say what each participant argued, how their positions moved over the discussion, and the outcome, if there was one. Use the participants' names. Keep it under 300 words.";

/** The topic and every spoken line, labelled with its speaker; silent handoffs are left out. */
export function transcriptText(topic: string, participants: DiscussionParticipant[], messages: Message[]): string {
  const lines = messages.flatMap((m) => {
    const text = m.content.trim();
    if (!text) return [];
    const name = m.participantId === null ? HOST_NAME : participants.find((p) => p.id === m.participantId)?.name ?? 'Someone';
    return [`**${name}:** ${text}`];
  });
  return [`Topic: "${topic}"`, ...lines].join('\n\n');
}

/** Has `modelId` summarize the discussion and saves the result, replacing any earlier summary. */
export async function summarizeDiscussion(deps: Deps, chatId: string, modelId: string): Promise<DiscussionSummary> {
  const { db } = deps;
  const { topic } = getDiscussionRow(db, chatId);
  checkSpend(db);
  const provider = chatProviderOrHttp(deps, modelId);
  const messages = [
    { role: 'system' as const, content: SUMMARY_PROMPT },
    { role: 'user' as const, content: transcriptText(topic, getParticipants(db, chatId), getChatMessages(db, chatId)) },
  ];

  const startedAt = now();
  const t0 = Date.now();
  let usage: Usage | null = null;
  const log = (status: UsageStatus) =>
    recordUsage(db, {
      purpose: 'summary', chatId, messageId: null, runId: null, kind: null, compare: false, modelId, usage, webSearch: false,
      webSearches: null, attachments: 0, firstTokenMs: null, durationMs: Date.now() - t0, status, createdAt: startedAt, threadKind: 'discussion',
    });

  let text: string;
  try {
    // Reasoning models think before answering, so the budget leaves room beyond the summary itself.
    text = (await provider.complete({ model: modelId, messages, maxTokens: 4000, onUsage: (u) => (usage = u) })).trim();
    log('complete');
  } catch (err) {
    log('error');
    throw new HttpError(502, err instanceof ProviderError ? err.message : 'Could not reach the model to write the summary.');
  }
  if (!text) throw new HttpError(502, 'The model returned an empty summary. Try again or pick another model.');
  const summary: DiscussionSummary = { text, modelId, cost: (usage as Usage | null)?.cost ?? null, createdAt: now() };
  saveSummary(db, chatId, summary);
  return summary;
}
