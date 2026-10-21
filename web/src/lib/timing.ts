import { COLD_LOAD_MS } from '../../../shared/localModels';
import type { ReplyTiming } from '../../../shared/types';

/** The speed, first-token and load-time details shown on a local reply; empty for OpenRouter replies and old rows. */
export function timingParts(t: ReplyTiming | null): string[] {
  if (!t) return [];
  const parts: string[] = [];
  if (t.tokensPerSec !== null && t.tokensPerSec > 0) {
    parts.push(`${t.tokensPerSec < 10 ? t.tokensPerSec.toFixed(1) : Math.round(t.tokensPerSec)} tok/s`);
  }
  if (t.firstTokenMs !== null && t.firstTokenMs > 0) parts.push(`${(t.firstTokenMs / 1000).toFixed(1)} s to first token`);
  if (t.loadMs !== null && t.loadMs >= COLD_LOAD_MS) parts.push(`loaded in ${(t.loadMs / 1000).toFixed(1)} s`);
  return parts;
}
