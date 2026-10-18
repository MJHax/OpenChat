/**
 * Video models from OpenRouter's `/videos/models`, their prices (from the free-form `pricing_skus`), the settings the
 * Video tab offers, and the request body. Shared so the server and the composer agree on prices and defaults.
 */

export interface VideoModel {
  id: string;
  name: string;
  /** OpenRouter cuts these short with "..."; the card links to the full page. */
  description: string;
  created: number | null;
  /** Allowed clip lengths in seconds, ascending. */
  durations: number[];
  resolutions: string[];
  aspects: string[];
  /** Exact sizes like "1280x720", used to estimate token-priced models. */
  sizes: string[];
  frames: { first: boolean; last: boolean };
  /** Whether the model can add sound. */
  sound: boolean;
  skus: Record<string, string>;
}

export interface VideoSettings {
  duration: number;
  resolution: string | null;
  aspect: string;
  sound: boolean;
}

/** Models that need a video as input (edit, upscale, avatars): a different use, left out of the tab. */
const VIDEO_INPUT_MODELS = new Set(['black-forest-labs/flux-video-edit', 'black-forest-labs/flux-video-upscale', 'runway/aleph-2', 'heygen/avatar-iv']);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseVideoModel(entry: any): VideoModel | null {
  if (!entry?.id || VIDEO_INPUT_MODELS.has(entry.id)) return null;
  const durations = (Array.isArray(entry.supported_durations) ? entry.supported_durations : []).filter((d: unknown) => typeof d === 'number').sort((a: number, b: number) => a - b);
  const frameTypes = strings(entry.supported_frame_images);
  if (durations.length === 0 && frameTypes.length === 0) return null;
  return {
    id: String(entry.id),
    name: String(entry.name ?? entry.id),
    description: typeof entry.description === 'string' ? entry.description : '',
    created: typeof entry.created === 'number' ? entry.created : null,
    durations,
    resolutions: strings(entry.supported_resolutions),
    aspects: strings(entry.supported_aspect_ratios),
    sizes: strings(entry.supported_sizes),
    frames: { first: frameTypes.includes('first_frame'), last: frameTypes.includes('last_frame') },
    sound: entry.generate_audio === true,
    skus: Object.fromEntries(Object.entries(entry.pricing_skus ?? {}).map(([k, v]) => [k, String(v)])),
  };
}

// ---- prices ----

type Sku =
  | { kind: 'perSecond' | 'tokens'; usd: number; res: string | null; audio: boolean | null; mode: 'i2v' | 't2v' | null }
  | { kind: 'perImage' | 'minimum'; usd: number }
  | { kind: 'ignore' }
  | { kind: 'unknown' };

const RES = /^(\d+p|\d+(\.\d+)?k)$/;
const WORDS = new Set(['cents', 'per', 'video', 'output', 'second', 'seconds', 'duration', 'text', 'image', 'to', 'with', 'without', 'audio', 'tokens']);

/** What one pricing key means. `cents_*` keys are in cents, the rest in dollars. */
function classify(key: string, raw: string): Sku {
  const value = Number(raw);
  if (Number.isNaN(value)) return { kind: 'unknown' };
  const usd = key.startsWith('cents_') || key.startsWith('minimum_cents_') ? value / 100 : value;
  // Only for inputs the tab never sends: reference images or video, continuing a video, upscaling.
  if (/^reference_|video_continuation|with_video_input|megapixel/.test(key)) return { kind: 'ignore' };
  if (key === 'cents_per_image_input') return { kind: 'perImage', usd };
  if (key === 'minimum_cents_per_generation') return { kind: 'minimum', usd };
  const parts = key.split('_');
  const res = parts.find((p) => RES.test(p))?.toLowerCase() ?? null;
  const audio = key.includes('without_audio') ? false : key.includes('with_audio') ? true : null;
  const mode = key.startsWith('image_to_video') ? 'i2v' : key.startsWith('text_to_video') ? 't2v' : null;
  if (!parts.every((p) => WORDS.has(p) || RES.test(p))) return { kind: 'unknown' };
  if (key.startsWith('video_tokens')) return { kind: 'tokens', usd, res, audio, mode };
  if (parts.includes('second') || parts.includes('seconds')) return { kind: 'perSecond', usd, res, audio, mode };
  return { kind: 'unknown' };
}

/** The best-matching rate of `kind` for these settings: a resolution match beats a mode match beats an audio match. */
function rate(skus: Sku[], kind: 'perSecond' | 'tokens', s: VideoSettings, hasStart: boolean): number | null {
  const res = s.resolution?.toLowerCase() ?? null;
  const mode = hasStart ? 'i2v' : 't2v';
  let best: { usd: number; score: number } | null = null;
  for (const k of skus) {
    if (k.kind !== kind) continue;
    if ((k.res && k.res !== res) || (k.mode && k.mode !== mode) || (k.audio !== null && k.audio !== s.sound)) continue;
    // With sound on, a with-audio rate beats everything: the other keys price silent clips.
    const score = (s.sound && k.audio === true ? 8 : 0) + (k.res ? 4 : 0) + (k.mode ? 2 : 0) + (k.audio !== null ? 1 : 0);
    if (!best || score > best.score) best = { usd: k.usd, score };
  }
  return best?.usd ?? null;
}

/** Width×height for the chosen resolution and shape, from the model's exact sizes. */
/** A resolution's short side in pixels: "720p" → 720, "2K" → 1440, "4K" → 2160; null when it can't be told. */
const SHORT_SIDE_K: Record<string, number> = { '1k': 1080, '2k': 1440, '4k': 2160 };
const shortSide = (res: string | null): number | null => {
  const p = /^(\d+)p$/i.exec(res ?? '');
  return p ? Number(p[1]) : SHORT_SIDE_K[(res ?? '').toLowerCase()] ?? null;
};

function frameSize(m: VideoModel, s: VideoSettings): [number, number] | null {
  const short = shortSide(s.resolution);
  if (s.resolution && short === null) return null;
  const [aw, ah] = s.aspect.split(':').map(Number);
  const sizes = m.sizes.map((x) => x.split('x').map(Number) as [number, number]).filter(([w, h]) => w > 0 && h > 0);
  // With a resolution, only sizes of exactly that height count; no match means the price can't be worked out.
  const fit = sizes.filter(([w, h]) => short === null || Math.min(w, h) === short);
  const target = aw > 0 && ah > 0 ? aw / ah : 16 / 9;
  return [...fit].sort((a, b) => Math.abs(a[0] / a[1] - target) - Math.abs(b[0] / b[1] - target))[0] ?? null;
}

/** Dollars with up to three decimals, never fewer than two. */
export function usd(n: number): string {
  const [whole, frac = ''] = n.toFixed(3).replace(/0+$/, '').split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

export interface VideoPrice {
  /** null: OpenChat can't work out the price before generating. */
  cost: number | null;
  estimated: boolean;
  perSecond: number | null;
  breakdown: string;
  /** What turning on sound, or the next resolution up, would add. */
  nextSteps: { label: string; extra: number }[];
}

function priceOnly(m: VideoModel, s: VideoSettings, photos: number): Omit<VideoPrice, 'nextSteps'> {
  const skus = Object.entries(m.skus).map(([k, v]) => classify(k, v));
  if (skus.some((k) => k.kind === 'unknown')) return { cost: null, estimated: true, perSecond: null, breakdown: 'Price after generating' };
  const perImage = skus.reduce((t, k) => t + (k.kind === 'perImage' ? k.usd : 0), 0) * photos;
  const minimum = skus.reduce((m, k) => (k.kind === 'minimum' ? Math.max(m, k.usd) : m), 0);
  const per = rate(skus, 'perSecond', s, photos > 0);
  const at = s.resolution ? ` at ${s.resolution}` : '';
  if (per !== null) {
    const cost = Math.max(minimum, per * s.duration + perImage);
    const photosNote = perImage ? ` + ${usd(perImage)} for photos` : '';
    return { cost, estimated: false, perSecond: per, breakdown: `${s.duration}s × ${usd(per)}/s${at}${photosNote} = ${usd(cost)}` };
  }
  const perToken = rate(skus, 'tokens', s, photos > 0);
  const size = frameSize(m, s);
  if (perToken !== null && size) {
    const cost = Math.max(minimum, (perToken * size[0] * size[1] * 24 * s.duration) / 1024 + perImage);
    return { cost, estimated: true, perSecond: cost / s.duration, breakdown: `about ${usd(cost)} for ${s.duration}s${at} (priced by video tokens)` };
  }
  return { cost: null, estimated: true, perSecond: null, breakdown: 'Price after generating' };
}

/** The price of one clip, exact when the model's pricing keys allow it. */
export function videoPrice(m: VideoModel, s: VideoSettings, photos: number): VideoPrice {
  const base = priceOnly(m, s, photos);
  const nextSteps: VideoPrice['nextSteps'] = [];
  if (base.cost !== null) {
    if (m.sound && !s.sound) {
      const withSound = priceOnly(m, { ...s, sound: true }, photos).cost;
      if (withSound !== null) nextSteps.push({ label: 'sound', extra: withSound - base.cost });
    }
    const up = sortedResolutions(m).find((r) => resPixels(r) > resPixels(s.resolution ?? ''));
    if (up) {
      const higher = priceOnly(m, { ...s, resolution: up }, photos).cost;
      if (higher !== null) nextSteps.push({ label: up, extra: higher - base.cost });
    }
  }
  return { ...base, nextSteps };
}

/** The lowest per-second rate without sound, for the card's "from $X/s". */
export function cheapestPerSecond(m: VideoModel): number | null {
  const skus = Object.entries(m.skus).map(([k, v]) => classify(k, v));
  if (skus.some((k) => k.kind === 'unknown')) return null;
  // Only rates for sizes the model actually offers: a 480p key on a model without 480p would understate it.
  const offered = new Set(m.resolutions.map((r) => r.toLowerCase()));
  const rates = skus.flatMap((k) => (k.kind === 'perSecond' && k.audio !== true && (!k.res || offered.size === 0 || offered.has(k.res)) ? [k.usd] : []));
  return rates.length ? Math.min(...rates) : null;
}

// ---- settings ----

const resPixels = (r: string): number => {
  const p = /^(\d+)p$/i.exec(r);
  if (p) return Number(p[1]);
  const k = /^([\d.]+)k$/i.exec(r);
  return k ? Number(k[1]) * 1000 : 0;
};
const sortedResolutions = (m: VideoModel) => [...m.resolutions].sort((a, b) => resPixels(a) - resPixels(b));
const ratio = (aspect: string) => {
  const [w, h] = aspect.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 0;
};
const nearest = <T>(options: T[], score: (o: T) => number): T => [...options].sort((a, b) => score(a) - score(b))[0];

/** Shortest length, 720p (else the lowest), sound off, and the start photo's shape when there is one. */
export function defaultVideoSettings(m: VideoModel, photoAspect: number | null): VideoSettings {
  const aspects = m.aspects.filter((a) => ratio(a) > 0);
  const aspect = photoAspect && aspects.length ? nearest(aspects, (a) => Math.abs(ratio(a) - photoAspect))
    : m.aspects.includes('16:9') ? '16:9' : m.aspects[0] ?? '16:9';
  const resolution = m.resolutions.includes('720p') ? '720p' : sortedResolutions(m)[0] ?? null;
  return { duration: m.durations[0] ?? 5, resolution, aspect, sound: false };
}

/** `s` with anything the model doesn't offer replaced by the nearest thing it does. */
export function snapVideoSettings(m: VideoModel, s: VideoSettings): VideoSettings {
  const duration = m.durations.length && !m.durations.includes(s.duration) ? nearest(m.durations, (d) => Math.abs(d - s.duration)) : s.duration;
  const resolution = m.resolutions.length === 0 ? null
    : s.resolution && m.resolutions.includes(s.resolution) ? s.resolution
    : nearest(sortedResolutions(m), (r) => Math.abs(resPixels(r) - resPixels(s.resolution ?? '720p')));
  const aspects = m.aspects.filter((a) => ratio(a) > 0);
  const aspect = m.aspects.length === 0 || m.aspects.includes(s.aspect) ? s.aspect
    : aspects.length ? nearest(aspects, (a) => Math.abs(ratio(a) - ratio(s.aspect))) : m.aspects[0];
  return { duration, resolution, aspect, sound: m.sound && s.sound };
}

/** The POST /videos body. Sound is always sent (the API turns it on by default); frames the model can't take are left out. */
export function buildVideoRequest(m: VideoModel, s: VideoSettings, prompt: string, frames: { first: string | null; last: string | null }): object {
  const frame = (url: string, frame_type: 'first_frame' | 'last_frame') => ({ type: 'image_url', image_url: { url }, frame_type });
  const frameImages = [
    ...(frames.first && m.frames.first ? [frame(frames.first, 'first_frame')] : []),
    ...(frames.last && m.frames.last ? [frame(frames.last, 'last_frame')] : []),
  ];
  return {
    model: m.id, prompt, duration: s.duration, ...(s.resolution ? { resolution: s.resolution } : {}), aspect_ratio: s.aspect,
    generate_audio: m.sound && s.sound, ...(frameImages.length ? { frame_images: frameImages } : {}),
  };
}
