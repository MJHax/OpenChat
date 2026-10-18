import { describe, it, expect } from 'vitest';
import { makeApp } from './appHelpers';
import { isLocalHost } from '../src/app';

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

// A site that resolves its own domain to 127.0.0.1 is same-origin with itself, so the browser's checks don't apply.
describe('DNS rebinding protection', () => {
  const at = (app: ReturnType<typeof makeApp>['app'], host: string, init: RequestInit = {}) =>
    app.request(`http://${host}/api/memories`, { ...init, headers: { 'Sec-Fetch-Site': 'same-origin', ...init.headers } });

  it('answers on local names, with or without a port', async () => {
    const { app } = makeApp();
    for (const host of ['localhost', '127.0.0.1:3000', '[::1]:3000', 'localhost:5173', 'app.localhost']) {
      expect((await at(app, host)).status).toBe(200);
    }
  });

  it('refuses reads and writes under any other name', async () => {
    const { app, call } = makeApp();
    expect((await at(app, 'attacker.example:3000')).status).toBe(403);
    const write = await at(app, 'attacker.example:3000', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"content":"injected"}',
    });
    expect(write.status).toBe(403);
    expect(await (await call('GET', '/api/memories')).json()).toEqual([]);
  });

  it('does not mistake look-alike names for local ones', () => {
    expect(isLocalHost('localhost.attacker.example')).toBe(false);
    expect(isLocalHost('127.0.0.1.attacker.example')).toBe(false);
    expect(isLocalHost('notlocalhost')).toBe(false);
    expect(isLocalHost('192.168.1.5')).toBe(false);
  });
});
