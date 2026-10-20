import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import type { SavedPrompt } from '../../shared/types';

describe('saved prompt routes', () => {
  it('supports create, list, edit and delete', async () => {
    const { call } = makeApp();
    const res = await call('POST', '/api/prompts', { title: ' Review ', content: '  Review {{file}} ' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as SavedPrompt;
    expect(created).toMatchObject({ title: 'Review', content: 'Review {{file}}' });

    const edited = (await (await call('PATCH', `/api/prompts/${created.id}`, { content: 'Check {{file}}' })).json()) as SavedPrompt;
    expect(edited).toMatchObject({ title: 'Review', content: 'Check {{file}}' });
    expect(edited.updatedAt).toBeGreaterThanOrEqual(created.createdAt);

    expect(((await (await call('GET', '/api/prompts')).json()) as SavedPrompt[]).length).toBe(1);
    expect((await call('DELETE', `/api/prompts/${created.id}`)).status).toBe(200);
    expect(await (await call('GET', '/api/prompts')).json()).toEqual([]);
  });

  it('lists the most recently updated first', async () => {
    const { call } = makeApp();
    const a = (await (await call('POST', '/api/prompts', { title: 'A', content: 'a' })).json()) as SavedPrompt;
    const b = (await (await call('POST', '/api/prompts', { title: 'B', content: 'b' })).json()) as SavedPrompt;
    await call('PATCH', `/api/prompts/${a.id}`, { title: 'A2' });
    const list = (await (await call('GET', '/api/prompts')).json()) as SavedPrompt[];
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('rejects empty content and unknown ids', async () => {
    const { call } = makeApp();
    expect((await call('POST', '/api/prompts', { title: 'x', content: '   ' })).status).toBe(400);
    expect((await call('PATCH', '/api/prompts/999', { content: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/api/prompts/999')).status).toBe(404);
  });
});
