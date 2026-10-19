/**
 * Image models from OpenRouter's image API (`/images/models` plus each model's `/endpoints` for pricing), and the
 * settings, prices and limits the Images tab works with. Shared so the server and the composer agree.
 */

export type ImagePrice =
  | { kind: 'image'; bySize: Record<string, number> }
  | { kind: 'token'; perOutputToken: number; perInputImageToken: number | null }
  | { kind: 'megapixel'; perMp: number }
  | { kind: 'unknown' };

export interface ImageModel {
  id: string;
  name: string;
  /** OpenRouter cuts these short with "..."; the card links to the full page. */
  description: string;
  created: number | null;
  aspects: string[];
  /** e.g. ['1K', '2K', '4K']; empty when the model has no size setting. */
  resolutions: string[];
  /** e.g. ['auto', 'low', 'medium', 'high']; empty when the model has no quality setting. */
  qualities: string[];
  transparent: boolean;
  /** How many images it accepts as references; 0 means it can't edit. */
  maxRefs: number;
  /** At least this many are required (a model that only edits). */
  minRefs: number;
  price: ImagePrice;
  /** Makes SVG (vector) images only. */
  svg?: boolean;
}

export interface ImageSettings {
  aspect: string;
  size: string | null;
  quality: string | null;
  transparent: boolean;
}

/** Typical output tokens per image by size, for estimating token-priced models before there is any history. */
export const TYPICAL_IMAGE_TOKENS: Record<string, number> = { '1k': 1290, '2k': 1800, '4k': 3600, default: 1290 };
/** How quality scales those tokens (medium = typical). */
export const QUALITY_TOKEN_FACTOR: Record<string, number> = { low: 0.25, medium: 1, high: 2.5, xhigh: 4, max: 6 };

const QUALITY_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

const values = (param: unknown): string[] => {
  const v = (param as { values?: unknown } | undefined)?.values;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};
const range = (param: unknown): { min: number; max: number } => {
  const p = param as { min?: unknown; max?: unknown } | undefined;
  return { min: typeof p?.min === 'number' ? p.min : 0, max: typeof p?.max === 'number' ? p.max : 0 };
};

function parsePrice(lines: unknown): ImagePrice {
  if (!Array.isArray(lines)) return { kind: 'unknown' };
  const out = lines.filter((l) => l?.billable === 'output_image' && typeof l.cost_usd === 'number');
  const unit = out[0]?.unit;
  if (unit === 'image') {
    return { kind: 'image', bySize: Object.fromEntries(out.map((l) => [typeof l.variant === 'string' ? l.variant.toLowerCase() : 'default', l.cost_usd])) };
  }
  if (unit === 'token') {
    const input = lines.find((l) => l?.billable === 'input_image' && l.unit === 'token' && typeof l.cost_usd === 'number');
    return { kind: 'token', perOutputToken: out[0].cost_usd, perInputImageToken: input ? input.cost_usd : null };
  }
  if (unit === 'megapixel') return { kind: 'megapixel', perMp: out[0].cost_usd };
  return { kind: 'unknown' };
}

/**
 * One model from the list entry and its endpoints response (null when that fetch failed: price unknown). Null for models
 * no provider serves.
 */
export function parseImageModel(entry: any, endpoints: any | null): ImageModel | null {
  const first = Array.isArray(endpoints?.endpoints) ? endpoints.endpoints[0] : undefined;
  if (endpoints && Array.isArray(endpoints.endpoints) && !first) return null;
  const params = { ...(first?.supported_parameters ?? {}), ...(entry?.supported_parameters ?? {}) };
  const formats = values(params.output_format);
  const refs = range(params.input_references);
  return {
    id: String(entry.id),
    name: String(entry.name ?? entry.id),
    description: typeof entry.description === 'string' ? entry.description : '',
    created: typeof entry.created === 'number' ? entry.created : null,
    aspects: values(params.aspect_ratio),
    resolutions: values(params.resolution),
    qualities: values(params.quality),
    transparent: values(params.background).includes('transparent'),
    maxRefs: refs.max,
    minRefs: refs.min,
    price: first ? parsePrice(first.pricing) : { kind: 'unknown' },
    ...(formats.length > 0 && formats.every((f) => f === 'svg') ? { svg: true } : {}),
  };
}

/** Pixels on a side for a size label: '768' → 768, '1.5K' → 1536. */
const sizePixels = (size: string): number => {
  const k = /^([\d.]+)k$/i.exec(size);
  return k ? Number(k[1]) * 1024 : Number(size) || 1024;
};

/** The supported value closest to `want` (ties go to the smaller one). */
function nearestSize(options: string[], want: string): string {
  const exact = options.find((o) => o.toLowerCase() === want.toLowerCase());
  if (exact) return exact;
  const px = sizePixels(want);
  return [...options].sort((a, b) => Math.abs(sizePixels(a) - px) - Math.abs(sizePixels(b) - px) || sizePixels(a) - sizePixels(b))[0];
}

function defaultQuality(qualities: string[]): string | null {
  if (qualities.length === 0) return null;
  if (qualities.includes('medium')) return 'medium';
  const ranked = qualities.filter((q) => QUALITY_ORDER.includes(q));
  if (ranked.length === 0) return qualities[0];
  const mid = QUALITY_ORDER.indexOf('medium');
  return ranked.sort((a, b) => Math.abs(QUALITY_ORDER.indexOf(a) - mid) - Math.abs(QUALITY_ORDER.indexOf(b) - mid))[0];
}

export function defaultSettings(m: ImageModel): ImageSettings {
  return snapSettings(m, { aspect: '1:1', size: '1K', quality: null, transparent: false });
}

/** `s` with anything the model doesn't offer replaced by the closest thing it does. */
export function snapSettings(m: ImageModel, s: ImageSettings): ImageSettings {
  const aspect = m.aspects.length === 0 || m.aspects.includes(s.aspect) ? s.aspect
    : m.aspects.includes('1:1') ? '1:1' : m.aspects.includes('auto') ? 'auto' : m.aspects[0];
  const size = m.resolutions.length === 0 ? null : nearestSize(m.resolutions, s.size ?? '1K');
  const quality = m.qualities.length === 0 ? null : s.quality && m.qualities.includes(s.quality) ? s.quality : defaultQuality(m.qualities);
  return { aspect, size, quality, transparent: m.transparent && s.transparent };
}

/** The cost of one image: exact for flat and megapixel prices, an estimate otherwise; `history` is the user's own average. */
export function estimateImageCost(m: ImageModel, s: ImageSettings, history: number | null): { cost: number | null; estimated: boolean } {
  const p = m.price;
  if (p.kind === 'image') {
    const sized = s.size ? p.bySize[s.size.toLowerCase()] : undefined;
    const cost = sized ?? p.bySize.default ?? (Object.keys(p.bySize).length === 1 ? Object.values(p.bySize)[0] : undefined);
    if (cost !== undefined) return { cost, estimated: false };
  }
  if (p.kind === 'megapixel') {
    const side = s.size ? sizePixels(s.size) : 1024;
    return { cost: (p.perMp * side * side) / 1_000_000, estimated: false };
  }
  if (history !== null) return { cost: history, estimated: true };
  if (p.kind === 'token') {
    const tokens = TYPICAL_IMAGE_TOKENS[s.size?.toLowerCase() ?? 'default'] ?? TYPICAL_IMAGE_TOKENS.default;
    return { cost: p.perOutputToken * tokens * (QUALITY_TOKEN_FACTOR[s.quality ?? 'medium'] ?? 1), estimated: true };
  }
  return { cost: null, estimated: true };
}

/** Why Generate is off for this many reference images, or null when it can go. */
export function canGenerate(m: ImageModel, refs: number): string | null {
  if (refs < m.minRefs) return 'This model needs a photo to edit.';
  if (refs > 0 && m.maxRefs === 0) return "This model can't edit images.";
  if (refs > m.maxRefs) return `This model accepts up to ${m.maxRefs} images.`;
  return null;
}
