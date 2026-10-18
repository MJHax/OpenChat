import { describe, it, expect } from 'vitest';
import { parseHash } from './route';

describe('parseHash', () => {
  it('maps hashes to routes', () => {
    expect(parseHash('')).toEqual({ page: 'chat', chatId: null });
    expect(parseHash('#/')).toEqual({ page: 'chat', chatId: null });
    expect(parseHash('#/chat/abc-123')).toEqual({ page: 'chat', chatId: 'abc-123' });
    expect(parseHash('#/models')).toEqual({ page: 'models' });
    expect(parseHash('#/settings')).toEqual({ page: 'settings' });
    expect(parseHash('#/stats')).toEqual({ page: 'stats' });
    expect(parseHash('#/garbage')).toEqual({ page: 'chat', chatId: null });
  });

  it('maps image threads', () => {
    expect(parseHash('#/images')).toEqual({ page: 'images', threadId: null });
    expect(parseHash('#/images/abc')).toEqual({ page: 'images', threadId: 'abc' });
  });
});
