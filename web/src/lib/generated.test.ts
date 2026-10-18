import { describe, it, expect } from 'vitest';
import { filterGenerated, needsShrinking } from './generated';
import type { GeneratedItems } from '../../../shared/types';

const items: GeneratedItems = {
  images: [
    { attachmentId: 'i1', threadId: 't1', threadTitle: 'Fox in a hat', createdAt: 2 },
    { attachmentId: 'i2', threadId: 't2', threadTitle: 'Beach sunset', createdAt: 1 },
  ],
  files: [
    { chatId: 'c1', chatTitle: 'AI model comparison', messageId: 'm1', name: 'ai-models.html', size: 31_000 },
    { chatId: 'c2', chatTitle: 'Brochure', messageId: 'm2', name: 'beach-brochure.html', size: 9_000 },
  ],
};

describe('filterGenerated', () => {
  it('keeps everything for an empty query', () => {
    expect(filterGenerated(items, '  ')).toEqual(items);
  });

  it('matches thread and chat titles and file names, ignoring case', () => {
    const r = filterGenerated(items, 'BEACH');
    expect(r.images.map((i) => i.attachmentId)).toEqual(['i2']);
    expect(r.files.map((f) => f.name)).toEqual(['beach-brochure.html']);
    expect(filterGenerated(items, 'models').files.map((f) => f.messageId)).toEqual(['m1']);
  });
});

describe('needsShrinking', () => {
  it('is true only above the 5 MB image limit', () => {
    expect(needsShrinking(5 * 1024 * 1024)).toBe(false);
    expect(needsShrinking(5 * 1024 * 1024 + 1)).toBe(true);
  });
});
