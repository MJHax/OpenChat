import { describe, it, expect } from 'vitest';
import list from './fixtures/image-models.json';
import flux3 from './fixtures/endpoints-black-forest-labs_flux-3-image.json';
import flux2pro from './fixtures/endpoints-black-forest-labs_flux_2-pro.json';
import banana from './fixtures/endpoints-google_gemini-nano-banana-2_1.json';
import gptImage from './fixtures/endpoints-openai_gpt-image-2_5-flare.json';
import vector from './fixtures/endpoints-recraft_recraft-v4_1-vector.json';
import krea from './fixtures/endpoints-krea_k3-edit.json';
import muse from './fixtures/endpoints-meta_muse-image.json';
import { canGenerate, defaultSettings, estimateImageCost, parseImageModel, snapSettings, type ImageModel } from './imageModels';

const entry = (id: string) => list.data.find((m) => m.id === id)!;
const model = (id: string, endpoints: unknown): ImageModel => {
  const m = parseImageModel(entry(id), endpoints);
  if (!m) throw new Error(`${id} was filtered out`);
  return m;
};

describe('parseImageModel', () => {
  it('reads sizes, shapes and flat prices by size', () => {
    const m = model('black-forest-labs/flux-3-image', flux3);
    expect(m.price).toEqual({ kind: 'image', bySize: { '768': 0.041, '1k': 0.048, '1.5k': 0.07, '2k': 0.1, '4k': 0.607 } });
    expect(m.resolutions).toEqual(['768', '1K', '1.5K', '2K', '4K']);
    expect(m.aspects).toContain('16:9');
    expect(m.maxRefs).toBe(10);
    expect(m.minRefs).toBe(0);
  });

  it('reads token prices', () => {
    expect(model('google/gemini-nano-banana-2.1', banana).price).toEqual({ kind: 'token', perOutputToken: 0.00003, perInputImageToken: null });
    expect(model('openai/gpt-image-2.5-flare', gptImage).price).toEqual({ kind: 'token', perOutputToken: 0.00003, perInputImageToken: 0.000008 });
  });

  it('reads quality and transparency', () => {
    const m = model('openai/gpt-image-2.5-flare', gptImage);
    expect(m.qualities).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(m.transparent).toBe(true);
    expect(model('black-forest-labs/flux-3-image', flux3).transparent).toBe(false);
  });

  it('reads megapixel prices', () => {
    expect(model('black-forest-labs/flux.2-pro', flux2pro).price).toEqual({ kind: 'megapixel', perMp: 0.03 });
  });

  it('marks missing prices unknown and keeps models needing a photo', () => {
    const m = model('krea/k3-edit', krea);
    expect(m.price).toEqual({ kind: 'unknown' });
    expect(m.minRefs).toBe(1);
    expect(model('black-forest-labs/flux-3-image', null).price).toEqual({ kind: 'unknown' });
  });

  it('leaves out SVG-only models and models nobody serves', () => {
    expect(parseImageModel(entry('recraft/recraft-v4.1-vector'), vector)).toBeNull();
    expect(parseImageModel(entry('meta/muse-image'), muse)).toBeNull();
  });
});

describe('estimateImageCost', () => {
  it('is exact for flat prices', () => {
    const m = model('black-forest-labs/flux-3-image', flux3);
    expect(estimateImageCost(m, { aspect: '1:1', size: '1K', quality: null, transparent: false }, null)).toEqual({ cost: 0.048, estimated: false });
    expect(estimateImageCost(m, { aspect: '1:1', size: '2K', quality: null, transparent: false }, null)).toEqual({ cost: 0.1, estimated: false });
  });

  it('estimates token prices from typical image sizes', () => {
    const r = estimateImageCost(model('google/gemini-nano-banana-2.1', banana), { aspect: '1:1', size: '1K', quality: null, transparent: false }, null);
    expect(r.estimated).toBe(true);
    expect(r.cost).toBeCloseTo(0.00003 * 1290);
  });

  it('scales token estimates by quality', () => {
    const m = model('openai/gpt-image-2.5-flare', gptImage);
    const at = (quality: string) => estimateImageCost(m, { aspect: '1:1', size: null, quality, transparent: false }, null).cost!;
    expect(at('medium')).toBeCloseTo(0.00003 * 1290);
    expect(at('low')).toBeCloseTo(0.00003 * 1290 * 0.25);
    expect(at('high')).toBeCloseTo(0.00003 * 1290 * 2.5);
  });

  it('prices megapixels at 1024×1024 for a square', () => {
    const r = estimateImageCost(model('black-forest-labs/flux.2-pro', flux2pro), { aspect: '1:1', size: null, quality: null, transparent: false }, null);
    expect(r).toEqual({ cost: expect.closeTo(0.03 * 1.048576, 6), estimated: false });
  });

  it("prefers the user's own average", () => {
    const m = model('google/gemini-nano-banana-2.1', banana);
    expect(estimateImageCost(m, defaultSettings(m), 0.051)).toEqual({ cost: 0.051, estimated: true });
  });

  it('has no price when the model has none', () => {
    expect(estimateImageCost(model('krea/k3-edit', krea), { aspect: '1:1', size: '1K', quality: null, transparent: false }, null)).toEqual({ cost: null, estimated: true });
  });
});

describe('settings', () => {
  it('defaults to a square, 1K and medium quality', () => {
    expect(defaultSettings(model('black-forest-labs/flux-3-image', flux3))).toEqual({ aspect: '1:1', size: '1K', quality: null, transparent: false });
    expect(defaultSettings(model('openai/gpt-image-2.5-flare', gptImage))).toEqual({ aspect: '1:1', size: null, quality: 'medium', transparent: false });
  });

  it('snaps settings a model does not offer', () => {
    const banana2 = model('google/gemini-nano-banana-2.1', banana);
    expect(snapSettings(banana2, { aspect: '7:5', size: '1.5K', quality: 'max', transparent: true })).toEqual({ aspect: '1:1', size: '1K', quality: null, transparent: false });
    const flare = model('openai/gpt-image-2.5-flare', gptImage);
    expect(snapSettings(flare, { aspect: '16:9', size: '4K', quality: null, transparent: false })).toEqual({ aspect: '16:9', size: null, quality: 'medium', transparent: false });
  });

  it('snaps to the nearest size', () => {
    const banana2 = model('google/gemini-nano-banana-2.1', banana);
    expect(snapSettings(banana2, { aspect: '1:1', size: '1.5K', quality: null, transparent: false }).size).toBe('1K');
    expect(snapSettings(model('krea/k3-edit', krea), { aspect: '1:1', size: '4K', quality: null, transparent: false }).size).toBe('2K');
  });
});

describe('canGenerate', () => {
  it('explains what is missing', () => {
    expect(canGenerate(model('krea/k3-edit', krea), 0)).toBe('This model needs a photo to edit.');
    expect(canGenerate(model('google/gemini-nano-banana-2.1', banana), 15)).toBe('This model accepts up to 14 images.');
    expect(canGenerate(model('google/gemini-nano-banana-2.1', banana), 1)).toBeNull();
    const noEdit = parseImageModel(entry('recraft/recraft-v4.1-flash'), { endpoints: [{ pricing: [] }] })!;
    expect(canGenerate(noEdit, 1)).toBe("This model can't edit images.");
    expect(canGenerate(noEdit, 0)).toBeNull();
  });
});
