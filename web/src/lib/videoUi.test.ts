import { describe, it, expect } from 'vitest';
import { formatVideoRate, framesProblem, renderHint, videoBadges } from './videoUi';
import type { VideoModel } from '../../../shared/videoModels';

const base: VideoModel = {
  id: 'x/v', name: 'V', description: '', created: null, durations: [4, 15], resolutions: ['480p', '720p', '1080p'], aspects: ['16:9'], sizes: [],
  frames: { first: true, last: true }, sound: true, skus: { duration_seconds_480p: '0.05', duration_seconds_720p: '0.08' },
};

describe('renderHint', () => {
  it('says "a few minutes" until there are three past clips', () => {
    expect(renderHint([])).toBe('usually a few minutes');
    expect(renderHint([30_000, 40_000])).toBe('usually a few minutes');
  });

  it('gives the middle half of past render times', () => {
    expect(renderHint([30_000, 32_000, 41_000, 45_000])).toBe('usually 30–45 s');
    expect(renderHint([120_000, 150_000, 200_000, 260_000])).toBe('usually 2–4 min');
  });
});

describe('formatVideoRate', () => {
  it('shows the cheapest silent rate', () => {
    expect(formatVideoRate(base)).toBe('from $0.05/s');
    expect(formatVideoRate({ ...base, skus: { video_tokens: '0.00001' } })).toBe('priced by video tokens');
    expect(formatVideoRate({ ...base, skus: {} })).toBe('Price unknown');
  });
});

describe('framesProblem', () => {
  it('names the photo a model cannot take', () => {
    expect(framesProblem(base, true, true)).toBeNull();
    expect(framesProblem({ ...base, frames: { first: true, last: false } }, true, true)).toBe("can't end on a photo");
    expect(framesProblem({ ...base, frames: { first: false, last: false } }, true, false)).toBe("can't start from a photo");
    expect(framesProblem({ ...base, frames: { first: false, last: false } }, false, false)).toBeNull();
  });
});

describe('videoBadges', () => {
  it('lists frames, sound, top resolution and lengths', () => {
    expect(videoBadges(base)).toEqual(['Start+end frames', 'Sound', 'Max 1080p', '4–15s']);
    expect(videoBadges({ ...base, frames: { first: true, last: false }, sound: false, resolutions: [], durations: [8] })).toEqual(['Start frame', '8s']);
  });
});
