import { describe, it, expect } from 'vitest';
import list from './fixtures/video-models.json';
import { buildVideoRequest, cheapestPerSecond, defaultVideoSettings, parseVideoModel, snapVideoSettings, videoPrice, type VideoModel, type VideoSettings } from './videoModels';

const model = (id: string): VideoModel => {
  const m = parseVideoModel(list.data.find((x) => x.id === id));
  if (!m) throw new Error(`${id} was filtered out`);
  return m;
};
const s = (over: Partial<VideoSettings>): VideoSettings => ({ duration: 5, resolution: '720p', aspect: '16:9', sound: false, ...over });

describe('parseVideoModel', () => {
  it('reads lengths, sizes and frame support', () => {
    const m = model('kwaivgi/kling-v3.0-std');
    expect(m.durations[0]).toBe(3);
    expect(m.resolutions).toEqual(['720p']);
    expect(m.frames).toEqual({ first: true, last: true });
    expect(m.sound).toBe(true);
    expect(model('x-ai/grok-imagine-video-1.5-lite').frames).toEqual({ first: true, last: false });
  });

  it('leaves out models that take a video as input', () => {
    for (const id of ['black-forest-labs/flux-video-edit', 'black-forest-labs/flux-video-upscale', 'runway/aleph-2', 'heygen/avatar-iv']) {
      expect(parseVideoModel(list.data.find((x) => x.id === id))).toBeNull();
    }
  });

  it('sorts durations', () => {
    expect(model('google/veo-3.1-lite').durations).toEqual([4, 6, 8]);
  });
});

describe('videoPrice', () => {
  it('is exact for a per-second price', () => {
    const p = videoPrice(model('kwaivgi/kling-v3.0-std'), s({ duration: 5 }), 1);
    expect(p).toMatchObject({ estimated: false, perSecond: 0.084, breakdown: '5s × $0.084/s at 720p = $0.42' });
    expect(p.cost).toBeCloseTo(0.42);
    expect(p.nextSteps.find((n) => n.label === 'sound')?.extra).toBeCloseTo(0.21);
  });

  it('picks the right audio and resolution key', () => {
    expect(videoPrice(model('google/veo-3.1-lite'), s({ duration: 4 }), 0).cost).toBeCloseTo(0.12);
    expect(videoPrice(model('google/veo-3.1-lite'), s({ duration: 4, sound: true }), 0).cost).toBeCloseTo(0.2);
    expect(videoPrice(model('minimax/hailuo-3-max'), s({ duration: 5, resolution: '480p' }), 1).cost).toBeCloseTo(0.25);
  });

  it('adds a per-photo fee in cents', () => {
    expect(videoPrice(model('x-ai/grok-imagine-video-1.5-lite'), s({ duration: 4, resolution: '480p' }), 1).cost).toBeCloseTo(0.09);
  });

  it('estimates token prices from the frame size', () => {
    const p = videoPrice(model('bytedance/seedance-2.5'), s({ duration: 5 }), 0);
    expect(p.estimated).toBe(true);
    expect(p.cost).toBeCloseTo((0.0000107 * 1280 * 720 * 24 * 5) / 1024);
  });

  it('estimates 4K token prices from a 4K frame', () => {
    const p = videoPrice(model('bytedance/seedance-2.0'), s({ duration: 4, resolution: '4K' }), 0);
    expect(p.cost).toBeCloseTo((0.000004 * 3840 * 2160 * 24 * 4) / 1024);
    const hd = videoPrice(model('bytedance/seedance-2.0'), s({ duration: 4, resolution: '1080p' }), 0);
    expect(hd.nextSteps.find((n) => n.label === '4K')!.extra).toBeGreaterThan(0);
  });

  it('has no price for a size it cannot work out', () => {
    const odd: VideoModel = { ...model('bytedance/seedance-2.0'), sizes: ['640x480'] };
    expect(videoPrice(odd, s({ resolution: '4K' }), 0).cost).toBeNull();
  });

  it('knows when it cannot price', () => {
    const odd: VideoModel = { ...model('kwaivgi/kling-v3.0-std'), skus: { mystery_fee: '1' } };
    expect(videoPrice(odd, s({}), 0).cost).toBeNull();
  });

  it('gives the cheapest rate for the card', () => {
    expect(cheapestPerSecond(model('google/veo-3.1-lite'))).toBeCloseTo(0.03);
    expect(cheapestPerSecond(model('x-ai/grok-imagine-video-1.5-lite'))).toBeCloseTo(0.02);
  });

  it('only quotes resolutions the model offers', () => {
    expect(cheapestPerSecond(model('alibaba/wan-2.6'))).toBeCloseTo(0.08); // its 480p key is for a size it doesn't offer
  });

  it('gives no "from" price when a key is unknown', () => {
    expect(cheapestPerSecond({ ...model('google/veo-3.1-lite'), skus: { duration_seconds: '0.05', mystery_fee: '1' } })).toBeNull();
  });

  it('prices every in-scope model without unknown keys, or says so', () => {
    const unpriced = list.data.map((e) => parseVideoModel(e)).filter((m): m is VideoModel => !!m)
      .filter((m) => videoPrice(m, defaultVideoSettings(m, null), m.frames.first ? 1 : 0).cost === null).map((m) => m.id);
    expect(unpriced).toEqual([]);
  });
});

describe('settings', () => {
  it('defaults to the shortest length, 720p, no sound, and the photo\'s shape', () => {
    expect(defaultVideoSettings(model('kwaivgi/kling-v3.0-std'), 4 / 3)).toEqual({ duration: 3, resolution: '720p', aspect: '1:1', sound: false });
    expect(defaultVideoSettings(model('x-ai/grok-imagine-video-1.5-lite'), null)).toMatchObject({ resolution: '720p', aspect: '16:9' });
    expect(defaultVideoSettings(model('minimax/hailuo-3-max'), null).resolution).toBe('480p');
  });

  it('snaps to what a model offers', () => {
    expect(snapVideoSettings(model('google/veo-3.1-lite'), s({ duration: 5, resolution: '480p', aspect: '1:1', sound: true })))
      .toEqual({ duration: 4, resolution: '720p', aspect: '9:16', sound: true }); // 9:16 is nearer a square than 16:9
    expect(snapVideoSettings(model('x-ai/grok-imagine-video-1.5-lite'), s({ sound: true })).sound).toBe(false);
  });
});

describe('buildVideoRequest', () => {
  const frames = { first: 'data:image/png;base64,AA', last: 'data:image/png;base64,BB' };

  it('sends both frames and never leaves sound on by accident', () => {
    expect(buildVideoRequest(model('kwaivgi/kling-v3.0-std'), s({}), 'cats meet', frames)).toEqual({
      model: 'kwaivgi/kling-v3.0-std', prompt: 'cats meet', duration: 5, resolution: '720p', aspect_ratio: '16:9', generate_audio: false,
      frame_images: [
        { type: 'image_url', image_url: { url: frames.first }, frame_type: 'first_frame' },
        { type: 'image_url', image_url: { url: frames.last }, frame_type: 'last_frame' },
      ],
    });
  });

  it('drops last frame for a model that only takes a first frame', () => {
    const body = buildVideoRequest(model('x-ai/grok-imagine-video-1.5-lite'), s({ resolution: '480p' }), 'p', frames) as { frame_images: unknown[]; generate_audio: boolean };
    expect(body.frame_images).toHaveLength(1);
    expect(body.generate_audio).toBe(false);
  });
});
