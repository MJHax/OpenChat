import { describe, it, expect } from 'vitest';
import { estimateContext, IMAGE_TOKENS, PDF_PAGE_TOKENS, pdfPages, textTokens, type ContextInput } from '../src/context';
import { fileInstructions } from '../src/prompt';
import { makeApp, readEvents } from './appHelpers';
import type { OpenRouterClient, StreamEvent } from '../src/openrouter';
import { addModel } from '../src/library';
import { withCatalogDefaults, type Attachment, type ChatSummary, type ContextUsage, type Message } from '../../shared/types';

let n = 0;
function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `m${n++}`, chatId: 'c', parentId: null, role, content, modelId: null, promptTokens: null, completionTokens: null, cost: null,
    status: 'complete', createdAt: 0, attachments: [], webSearch: false, sources: [], webSearches: null, participantId: null, handoffTo: null, effort: null, ...extra,
  };
}
const file = (kind: Attachment['kind'], id: string): Attachment => ({ id, kind, filename: `${id}.x`, mime: '', size: 0 });

const input = (path: Message[], extra: Partial<ContextInput> = {}): ContextInput => ({
  modelId: 'm/x', contextLength: 1000, system: null, path, canViewImages: true, loadData: () => Buffer.alloc(0), ...extra,
});
const sum = (u: ContextUsage) => Object.values(u.parts).reduce((a, b) => a + b, 0);

describe('estimateContext', () => {
  it('estimates a chat with no reported usage from its text', () => {
    const u = estimateContext(input([msg('user', 'x'.repeat(40))], { system: 'y'.repeat(8) }));
    expect(u).toMatchObject({ used: 12, estimated: true, contextLength: 1000, parts: { system: 2, user: 10, assistant: 0, search: 0 } });
  });

  it("uses the latest reply's real totals, scaling the split to its prompt", () => {
    const u = estimateContext(input([
      msg('user', 'x'.repeat(40)),
      msg('assistant', 'y'.repeat(40), { promptTokens: 30, completionTokens: 7 }),
    ], { system: 'z'.repeat(40) }));
    expect(u.estimated).toBe(false);
    expect(u.used).toBe(37);
    expect(u.parts).toEqual({ system: 15, user: 15, assistant: 7, attachments: 0, search: 0 });
  });

  it('gives what the other parts leave of a searching reply\'s prompt to search', () => {
    const u = estimateContext(input([
      msg('user', 'x'.repeat(40)),
      msg('assistant', 'answer', { promptTokens: 500, completionTokens: 20, webSearches: 2 }),
    ]));
    expect(u.parts).toMatchObject({ user: 10, search: 490, assistant: 20 });
    expect(u.used).toBe(520);
  });

  it('adds estimates for messages after the latest reply', () => {
    const u = estimateContext(input([
      msg('user', 'hi'),
      msg('assistant', 'hello', { promptTokens: 10, completionTokens: 2 }),
      msg('user', 'x'.repeat(400)),
    ]));
    expect(u.used).toBe(112);
    expect(sum(u)).toBe(u.used);
  });

  it('counts attachments by kind, and image notes for models that cannot view images', () => {
    const data: Record<string, Buffer> = {
      t: Buffer.from('a'.repeat(80)),
      p: Buffer.from('<< /Type /Page >> << /Type/Page >> << /Type /Pages >>', 'latin1'),
    };
    const path = [msg('user', '', { attachments: [file('text', 't'), file('pdf', 'p'), file('image', 'i')] })];
    const loadData = (id: string) => data[id] ?? Buffer.alloc(0);
    expect(estimateContext(input(path, { loadData })).parts.attachments).toBe(20 + 2 * PDF_PAGE_TOKENS + IMAGE_TOKENS);
    expect(estimateContext(input(path, { loadData, canViewImages: false })).parts.attachments).toBeLessThan(20 + 2 * PDF_PAGE_TOKENS + 50);
  });

  it('keeps parts summing exactly to the total after rounding', () => {
    const u = estimateContext(input([
      msg('user', 'abc'), msg('assistant', 'defgh'), msg('user', 'ij'),
      msg('assistant', 'k', { promptTokens: 997, completionTokens: 1 }),
    ], { system: 'lmnopqr' }));
    expect(sum(u)).toBe(998);
  });
});

describe('pdfPages', () => {
  it('counts at least one page', () => {
    expect(pdfPages(Buffer.from('%PDF-1.7 compressed'))).toBe(1);
  });
});

describe('GET /api/context', () => {
  const streamChat: OpenRouterClient['streamChat'] = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'delta', text: 'Hello' };
    yield { type: 'usage', usage: { promptTokens: 40, completionTokens: 5, cost: 0.001, webSearches: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null } };
  };

  it("reports the chat's usage against the model's window", async () => {
    const { db, call } = makeApp({ streamChat });
    addModel(db, withCatalogDefaults({ id: 'm/x', name: 'X', contextLength: 8000 }));
    const chatId = ((await (await call('POST', '/api/chats')).json()) as ChatSummary).id;
    await readEvents(await call('POST', `/api/chats/${chatId}/messages`, { content: 'Hi', modelId: 'm/x' }));
    const u = (await (await call('GET', `/api/context?model=m%2Fx&chat=${chatId}`)).json()) as ContextUsage;
    expect(u).toMatchObject({ modelId: 'm/x', contextLength: 8000, used: 45, estimated: false });
  });

  it('works without a chat, and checks its inputs', async () => {
    const { call } = makeApp();
    const u = (await (await call('GET', '/api/context?model=m%2Funknown')).json()) as ContextUsage;
    // A new chat still carries the file section of the system prompt.
    expect(u).toMatchObject({ contextLength: null, used: textTokens(fileInstructions([])), estimated: true });
    expect(u.parts.system).toBeGreaterThan(0);
    expect((await call('GET', '/api/context')).status).toBe(400);
    expect((await call('GET', '/api/context?model=m%2Fx&chat=nope')).status).toBe(404);
  });

  it("counts the chat's instructions, or a new chat's draft, in the system prompt", async () => {
    const { call } = makeApp();
    const system = async (query: string) => ((await (await call('GET', `/api/context?model=m%2Fx${query}`)).json()) as ContextUsage).parts.system;
    const base = await system('');
    const words = 'Answer in French. '.repeat(20);
    expect(await system(`&instructions=${encodeURIComponent(words)}`)).toBeGreaterThan(base + 50);
    const chatId = ((await (await call('POST', '/api/chats', { instructions: words })).json()) as ChatSummary).id;
    expect(await system(`&chat=${chatId}`)).toBeGreaterThan(base + 50);
    // A saved chat's own instructions win over a draft.
    expect(await system(`&chat=${chatId}&instructions=x`)).toBe(await system(`&chat=${chatId}`));
  });
});
