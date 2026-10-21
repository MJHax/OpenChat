import type { LibraryModel, LocalServerStatus } from '../../../shared/types';
import { formatContext, formatPricePerM } from './format';

/** 'all', 'openrouter', or a local server's id. */
export type SourceFilter = 'all' | 'openrouter' | string;

export function sourceOptions(servers: LocalServerStatus[]): { id: SourceFilter; label: string }[] {
  return [{ id: 'all', label: 'All' }, { id: 'openrouter', label: 'OpenRouter' }, ...servers.map((s) => ({ id: s.id, label: s.name }))];
}

/** A download size in 1024-based units, e.g. "1.4 GB"; empty when unknown. */
export function formatSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${i >= 3 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** The small print under a model's name in the picker. */
export function modelDetails(m: LibraryModel): string {
  if (m.source === 'local') {
    const window = formatContext(m.contextWindow);
    return ['Free · local', window && `${window} context`].filter(Boolean).join(' · ');
  }
  return [
    m.promptPrice !== null && `${formatPricePerM(m.promptPrice)} in · ${formatPricePerM(m.completionPrice)} out`,
    formatContext(m.contextLength) && `${formatContext(m.contextLength)} context`,
  ].filter(Boolean).join(' · ');
}
