import { describe, it, expect } from 'vitest';
import { parseHash } from './route';

describe('parseHash', () => {
  it('maps hashes to routes', () => {
    expect(parseHash('')).toEqual({ page: 'chat', chatId: null });
    expect(parseHash('#/')).toEqual({ page: 'chat', chatId: null });
    expect(parseHash('#/chat/abc-123')).toEqual({ page: 'chat', chatId: 'abc-123' });
    expect(parseHash('#/models')).toEqual({ page: 'models' });
    expect(parseHash('#/settings')).toEqual({ page: 'settings', tab: 'general', section: null });
    expect(parseHash('#/stats')).toEqual({ page: 'stats' });
    expect(parseHash('#/garbage')).toEqual({ page: 'chat', chatId: null });
  });

  it('maps settings tabs and sections', () => {
    expect(parseHash('#/settings/data')).toEqual({ page: 'settings', tab: 'data', section: null });
    expect(parseHash('#/settings/memory')).toEqual({ page: 'settings', tab: 'memory', section: null });
    expect(parseHash('#/settings/general/limits')).toEqual({ page: 'settings', tab: 'general', section: 'limits' });
    expect(parseHash('#/settings/bogus')).toEqual({ page: 'settings', tab: 'general', section: null });
  });

  it('maps video threads', () => {
    expect(parseHash('#/video')).toEqual({ page: 'video', threadId: null });
    expect(parseHash('#/video/v1')).toEqual({ page: 'video', threadId: 'v1' });
  });

  it('maps discussions', () => {
    expect(parseHash('#/discussions')).toEqual({ page: 'discussions', discussionId: null });
    expect(parseHash('#/discussions/abc')).toEqual({ page: 'discussions', discussionId: 'abc' });
  });

  it('maps image threads', () => {
    expect(parseHash('#/images')).toEqual({ page: 'images', threadId: null });
    expect(parseHash('#/images/abc')).toEqual({ page: 'images', threadId: 'abc' });
  });
});
