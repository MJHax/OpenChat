import { defaultSettings, estimateImageCost, type ImageModel } from '../../../shared/imageModels';

/** Dollars with up to three decimals, never fewer than two: $0.048, $0.03, $1.20. */
export function money(usd: number): string {
  const fixed = usd.toFixed(usd < 0.001 && usd > 0 ? 4 : 3).replace(/0+$/, '');
  const [whole, frac = ''] = fixed.split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

/** The card's price line; `avg` is the user's own average for the model, when they've used it. */
export function formatImagePrice(m: ImageModel, avg: number | null): string {
  const s = defaultSettings(m);
  const p = m.price;
  let line: string;
  if (p.kind === 'image') {
    const { cost } = estimateImageCost(m, s, null);
    line = cost === null ? 'Price unknown' : `${money(cost)} / image${s.size ? ` at ${s.size}` : ''}`;
  } else if (p.kind === 'megapixel') {
    line = `${money(p.perMp)} / MP (~${money(estimateImageCost(m, { ...s, size: null }, null).cost!)} at 1024×1024)`;
  } else if (p.kind === 'token') {
    line = `~${money(estimateImageCost(m, s, null).cost!)} / image`;
  } else {
    line = 'Price unknown';
  }
  return avg === null ? line : `${line} · your avg ${money(avg)}`;
}

const sizeRank = (size: string) => {
  const k = /^([\d.]+)k$/i.exec(size);
  return k ? Number(k[1]) * 1024 : Number(size) || 0;
};

/** What the model can do, for the card's pills. */
export function imageBadges(m: ImageModel): string[] {
  const out: string[] = [];
  if (m.minRefs >= 1) out.push('Needs a photo');
  if (m.maxRefs > 0) out.push(`Edits · up to ${m.maxRefs} refs`);
  if (m.resolutions.length) out.push(`Max ${[...m.resolutions].sort((a, b) => sizeRank(b) - sizeRank(a))[0]}`);
  if (m.transparent) out.push('Transparent');
  return out;
}
