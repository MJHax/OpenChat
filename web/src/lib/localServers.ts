import { DETECT_CANDIDATES, SERVER_TYPE_NAMES, type LocalServerType } from '../../../shared/localModels';
import type { LocalServerStatus } from '../../../shared/types';

export function statusLabel(s: LocalServerStatus): string {
  if (!s.enabled) return 'Turned off';
  if (!s.online) return 'Offline';
  const n = s.modelCount ?? 0;
  return `Online · ${n} ${n === 1 ? 'model' : 'models'}`;
}

export function defaultName(type: LocalServerType): string {
  return SERVER_TYPE_NAMES[type];
}

export function defaultAddress(type: LocalServerType): string {
  return DETECT_CANDIDATES.find((c) => c.type === type)?.baseUrl ?? '';
}
