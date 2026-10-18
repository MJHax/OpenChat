import { describe, it, expect } from 'vitest';
import { formatImagePrice, imageBadges } from './imagePrice';
import type { ImageModel } from '../../../shared/imageModels';

const base: ImageModel = {
  id: 'x/m', name: 'M', description: '', created: null, aspects: ['1:1'], resolutions: ['1K', '2K'], qualities: [], transparent: false,
  maxRefs: 0, minRefs: 0, price: { kind: 'unknown' },
};

describe('formatImagePrice', () => {
  it('shows a flat price at the default size', () => {
    expect(formatImagePrice({ ...base, price: { kind: 'image', bySize: { '1k': 0.048, '2k': 0.1 } } }, null)).toBe('$0.048 / image at 1K');
  });

  it('marks token prices as estimates', () => {
    expect(formatImagePrice({ ...base, price: { kind: 'token', perOutputToken: 0.00003, perInputImageToken: null } }, null)).toBe('~$0.039 / image');
  });

  it('shows megapixel prices with a square example', () => {
    expect(formatImagePrice({ ...base, resolutions: [], price: { kind: 'megapixel', perMp: 0.03 } }, null)).toBe('$0.03 / MP (~$0.031 at 1024×1024)');
  });

  it('says when there is no price', () => {
    expect(formatImagePrice(base, null)).toBe('Price unknown');
  });

  it("adds the user's own average", () => {
    expect(formatImagePrice({ ...base, price: { kind: 'image', bySize: { '1k': 0.048 } } }, 0.04)).toBe('$0.048 / image at 1K · your avg $0.04');
  });
});

describe('imageBadges', () => {
  it('lists what the model can do', () => {
    expect(imageBadges({ ...base, maxRefs: 14, resolutions: ['1K', '2K', '4K'], transparent: true })).toEqual(['Edits · up to 14 refs', 'Max 4K', 'Transparent']);
    expect(imageBadges({ ...base, maxRefs: 8, minRefs: 1, resolutions: [] })).toEqual(['Needs a photo', 'Edits · up to 8 refs']);
    expect(imageBadges({ ...base, resolutions: ['1K', '2K'] })).toEqual(['Max 2K']);
  });
});
