import { describe, it, expect } from 'vitest';
import { renderReport } from '../src/discussion/report';
import { makeApp } from './appHelpers';
import { newDiscussion, seedModel } from './discussionHelpers';
import type { DiscussionDetail, Message } from '../../shared/types';

const msg = (over: Partial<Message>): Message => ({
  id: 'm', chatId: 'c', parentId: null, role: 'assistant', content: '', modelId: 'test/tools', promptTokens: null, completionTokens: null,
  cost: null, status: 'complete', createdAt: 0, attachments: [], webSearch: false, sources: [], webSearches: null, participantId: null,
  handoffTo: null, effort: null, contextDropped: false, timing: null, ...over,
});

const detail = (messages: Message[], summary: DiscussionDetail['summary'] = null): DiscussionDetail => ({
  chat: { id: 'c', title: 'Chicken or egg', updatedAt: 0, totalCost: 0.0312 },
  topic: 'Which came first, the chicken or the egg?',
  participants: [
    { id: 'egg', position: 0, name: 'Egg-Defender', modelId: 'test/egg-model', instructions: 'secret egg plan', isModerator: false, turns: 2, cost: 0.021 },
    { id: 'mod', position: 1, name: 'Moderator', modelId: 'test/mod-model', instructions: '', isModerator: true, turns: 0, cost: 0.001 },
  ],
  messages,
  state: { status: 'ended', endReason: 'limit', endNote: null, turnLimit: 2, turnsTaken: 2, moderatorDecides: false, moderatorNoteAfter: null },
  summary,
});

describe('discussion report', () => {
  it('renders names, models, costs and the summary into the report', () => {
    const html = renderReport(detail([
      msg({ participantId: 'egg', content: 'The **egg** came first.' }),
      msg({ participantId: 'mod', content: '', handoffTo: 'egg' }),
      msg({ role: 'user', content: 'Keep going.' }),
    ], { text: 'They agreed on the egg.', modelId: 'test/cheap', cost: 0.001, createdAt: 0 }), { generatedAt: Date.UTC(2026, 9, 18) });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h1>Which came first, the chicken or the egg?</h1>');
    expect(html).toContain('test/egg-model');
    expect(html).toContain('$0.021');
    expect(html).toContain('<strong>egg</strong>');
    expect(html).toContain('Moderator → Egg-Defender');
    expect(html).toContain('You (host)');
    expect(html).toContain('They agreed on the egg.');
    expect(html).not.toContain('secret egg plan');
    expect(html).not.toContain('<script');
  });

  it('shows small costs instead of rounding them to $0.00', () => {
    const d = detail([]);
    d.participants[0].cost = 0.000041475;
    d.participants[1].cost = 0;
    const html = renderReport(d, { generatedAt: 0 });
    expect(html).toContain('$0.000041');
    expect(html).toContain('$0.00<');
  });

  it('renders model HTML inert', () => {
    const html = renderReport(detail([msg({ participantId: 'egg', content: '<script>alert(1)</script> [x](javascript:alert(1))' })]), { generatedAt: 0 });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript:');
  });

  it('serves the report with the restrictive CSP', async () => {
    const { db, call } = makeApp();
    seedModel(db, 'test/tools', true);
    const d = (await (await call('POST', '/api/discussions', newDiscussion())).json()) as DiscussionDetail;
    const res = await call('GET', `/api/discussions/${d.chat.id}/report`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.toLowerCase()).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
    expect(await res.text()).toContain('Which came first, the chicken or the egg?');
  });
});
