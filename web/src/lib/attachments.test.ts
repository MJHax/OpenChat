import { describe, it, expect } from 'vitest';
import { addError, addErrors, guessKind, sendBlockReason, skippedImagesNotice, withRestored } from './attachments';
import { MB, TOO_MANY_FILES, TOO_MUCH_TOTAL, UNSUPPORTED_TYPE } from '../../../shared/attachments';
import type { Attachment, LibraryModel } from '../../../shared/types';

const model = (id: string, displayName: string, inputModalities: string[]): LibraryModel => ({
  id, displayName, contextLength: null, promptPrice: null, completionPrice: null, isDefault: false, inputModalities, supportsTools: false,
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

describe('addError for files that may not be text', () => {
  it('reports unsupported image formats instead of a text-size error', () => {
    expect(addError([], { name: 'photo.heic', size: 3 * MB, type: 'image/heic' })).toBe(UNSUPPORTED_TYPE);
    expect(addError([], { name: 'small.heic', size: 100, type: 'image/heic' })).toBe(UNSUPPORTED_TYPE);
  });

  it('applies the text limit only to files that look like text', () => {
    expect(addError([], { name: 'app.log', size: 2 * MB, type: 'text/plain' })).toBe('app.log is too large. The limit for text files is 1 MB.');
    expect(addError([], { name: 'data.json', size: 2 * MB, type: 'application/json' })).toBe('data.json is too large. The limit for text files is 1 MB.');
    expect(addError([], { name: 'main.rs', size: 2 * MB, type: '' })).toBe('main.rs is too large. The limit for text files is 1 MB.');
  });

  it('lets the server decide other types, up to the largest upload', () => {
    expect(addError([], { name: 'report.docx', size: 4 * MB, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBeNull();
    expect(addError([], { name: 'types.ts', size: 2 * MB, type: 'video/mp2t' })).toBeNull();
    expect(addError([], { name: 'huge.zip', size: 25 * MB, type: 'application/zip' })).toBe('huge.zip is too large. The limit is 20 MB.');
  });
});

describe('addErrors', () => {
  it('counts files accepted earlier in the same batch, but not rejected ones', () => {
    const nine = Array.from({ length: 9 }, () => ({ size: 1 }));
    const files = [
      { name: 'huge.png', size: 6 * MB, type: 'image/png' },
      { name: 'a.txt', size: 1, type: 'text/plain' },
      { name: 'b.txt', size: 1, type: 'text/plain' },
    ];
    expect(addErrors(nine, files)).toEqual(['huge.png is too large. The limit for image files is 5 MB.', null, TOO_MANY_FILES]);
  });

  it('leaves the existing list alone', () => {
    const existing = [{ size: 1 }];
    addErrors(existing, [{ name: 'a.txt', size: 1, type: 'text/plain' }]);
    expect(existing).toHaveLength(1);
  });
});

describe('withRestored', () => {
  const item = (key: string, id: string | null) => ({ key, attachment: id ? { ...image, id } : null });
  it('puts restored items first and drops current items for the same attachment', () => {
    const current = [item('new', 'n'), item('dup', 'r1'), item('failed', null)];
    const restored = [item('r1', 'r1'), item('r2', 'r2')];
    expect(withRestored(current, restored).map((i) => i.key)).toEqual(['r1', 'r2', 'new', 'failed']);
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
