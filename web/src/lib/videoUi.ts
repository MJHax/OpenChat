import { cheapestPerSecond, usd, type VideoModel } from '../../../shared/videoModels';

/** "usually 30–45 s" from the middle half of the user's past render times for a model; vague until there are three. */
export function renderHint(pastMs: number[]): string {
  if (pastMs.length < 3) return 'usually a few minutes';
  const sorted = [...pastMs].sort((a, b) => a - b);
  const lo = sorted[Math.floor((sorted.length - 1) * 0.25)];
  const hi = sorted[Math.ceil((sorted.length - 1) * 0.75)];
  if (hi < 90_000) {
    const s = (ms: number) => Math.round(ms / 5000) * 5;
    return `usually ${s(lo)}–${s(hi)} s`;
  }
  const m = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  return `usually ${m(lo)}–${m(hi)} min`;
}

/** The line under "Rendering…": the usual wait (or that this one is slow), the job's status, and any failed check. */
export function renderingNote(elapsedMs: number, hint: string, status: string | null | undefined, lastError: string | null | undefined): string {
  const parts = elapsedMs >= 30 * 60_000 ? ['Taking longer than usual', 'still checking every 5 min'] : [hint];
  parts.push('safe to leave this page');
  if (status) parts.push(status.replace(/_/g, ' '));
  if (lastError) parts.push(`last check failed: ${lastError} Retrying.`);
  return parts.join(' · ');
}

/** The card's price line: the cheapest silent per-second rate. */
export function formatVideoRate(m: VideoModel): string {
  const rate = cheapestPerSecond(m);
  if (rate !== null) return `from ${usd(rate)}/s`;
  return Object.keys(m.skus).some((k) => k.startsWith('video_tokens')) ? 'priced by video tokens' : 'Price unknown';
}

/** Why `m` can't take the photos that are filled in; null when it can. */
export function framesProblem(m: VideoModel, start: boolean, end: boolean): string | null {
  if (start && !m.frames.first) return "can't start from a photo";
  if (end && !m.frames.last) return "can't end on a photo";
  return null;
}

const resRank =(r: string) => Number(/^(\d+)p$/.exec(r)?.[1] ?? (/^([\d.]+)k$/i.exec(r) ? Number(/^([\d.]+)/.exec(r)![1]) * 1000 : 0));

export function videoBadges(m: VideoModel): string[] {
  const out: string[] = [];
  if (m.frames.first) out.push(m.frames.last ? 'Start+end frames' : 'Start frame');
  if (m.sound) out.push('Sound');
  if (m.resolutions.length) out.push(`Max ${[...m.resolutions].sort((a, b) => resRank(b) - resRank(a))[0]}`);
  if (m.durations.length) out.push(m.durations.length > 1 ? `${m.durations[0]}–${m.durations.at(-1)}s` : `${m.durations[0]}s`);
  return out;
}
