import { describe, it, expect } from 'vitest';
import { addError, guessKind, sendBlockReason, skippedImagesNotice } from './attachments';
import { MB, TOO_MANY_FILES, TOO_MUCH_TOTAL } from '../../../shared/attachments';
import type { Attachment, LibraryModel } from '../../../shared/types';

const model = (id: string, displayName: string, inputModalities: string[]): LibraryModel => ({
  id, displayName, contextLength: null, promptPrice: null, completionPrice: null, isDefault: false, inputModalities,
});
const vision = model('v/vision', 'Vision', ['text', 'image']);
const textOnly = model('t/text', 'Text Model', ['text']);
const image: Attachment = { id: 'i', kind: 'image', filename: 'photo.png', mime: 'image/png', size: 10 };

describe('guessKind', () => {
  it('guesses from the browser type and extension', () => {
    expect(guessKind({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(guessKind({ name: 'a.webp', type: 'image/webp' })).toBe('image');
    expect(guessKind({ name: 'x.PDF', type: '' })).toBe('pdf');
    expect(guessKind({ name: 'doc', type: 'application/pdf' })).toBe('pdf');
    expect(guessKind({ name: 'main.rs', type: '' })).toBe('text');
    expect(guessKind({ name: 'icon.svg', type: 'image/svg+xml' })).toBe('text');
  });
});

describe('addError', () => {
  it('checks the per-kind limit, the file count and the total size', () => {
    expect(addError([], { name: 'big.png', size: 6 * MB, type: 'image/png' })).toBe('big.png is too large. The limit for image files is 5 MB.');
    expect(addError([], { name: 'ok.png', size: 5 * MB, type: 'image/png' })).toBeNull();
    const ten = Array.from({ length: 10 }, () => ({ size: 1 }));
    expect(addError(ten, { name: 'a.txt', size: 1, type: 'text/plain' })).toBe(TOO_MANY_FILES);
    const heavy = [{ size: 20 * MB }, { size: 9 * MB }];
    expect(addError(heavy, { name: 'b.pdf', size: 2 * MB, type: 'application/pdf' })).toBe(TOO_MUCH_TOTAL);
  });
});

describe('sendBlockReason', () => {
  it('blocks new images for models that cannot view them', () => {
    expect(sendBlockReason(['image'], [textOnly])).toBe("Text Model can't view images. Remove the image or pick another model.");
    expect(sendBlockReason(['image'], [vision, textOnly])).toBe("Some of the compare models can't view images. Remove the image or pick other models.");
    expect(sendBlockReason(['image'], [vision])).toBeNull();
    expect(sendBlockReason(['pdf', 'text'], [textOnly])).toBeNull();
  });
});

describe('skippedImagesNotice', () => {
  it('warns when an earlier image will be skipped for a model', () => {
    const path = [{ attachments: [image] }, { attachments: [] }];
    expect(skippedImagesNotice(path, [textOnly])).toBe('Images earlier in this chat will be skipped for Text Model.');
    expect(skippedImagesNotice(path, [vision])).toBeNull();
    expect(skippedImagesNotice([{ attachments: [] }], [textOnly])).toBeNull();
  });
});
