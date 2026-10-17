import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';

// A generated page runs in a null-origin sandbox, and a page it navigates to is cross-site. Neither may change data,
// even with a no-cors "simple" request that the browser sends without asking first.
describe('write protection', () => {
  const post = (app: ReturnType<typeof makeApp>['app'], headers: Record<string, string>, body = '{"content":"injected"}') =>
    app.request('/api/memories', { method: 'POST', headers, body });

  it('accepts JSON from the app itself', async () => {
    const { app } = makeApp();
    expect((await post(app, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(201);
  });

  it('rejects a text/plain body', async () => {
    const { app, call } = makeApp();
    expect((await post(app, { 'Content-Type': 'text/plain;charset=UTF-8' })).status).toBe(415);
    expect(await (await call('GET', '/api/memories')).json()).toEqual([]);
  });

  it('rejects writes from a null origin', async () => {
    const { app } = makeApp();
    expect((await post(app, { 'Content-Type': 'application/json', Origin: 'null' })).status).toBe(403);
  });

  it('rejects cross-site writes, even without a body', async () => {
    const { app } = makeApp();
    expect((await post(app, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await app.request('/api/chats', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });

  it('still allows cross-site reads', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/memories', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(200);
  });
});
