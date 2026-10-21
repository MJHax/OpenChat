import type { LibraryModel, LocalAvailability } from '../../../shared/types';

/** The badge for a local model that can't reply right now; null when it's ready or not known yet. */
export function availabilityLabel(a: LocalAvailability | undefined): string | null {
  return a === 'offline' ? 'Offline' : a === 'missing' ? 'Not installed' : a === 'off' ? 'Turned off' : null;
}

/** Whether a Compare list entry can't be clicked: a ticked one always can (so it can be removed), an unticked one not when the list is full or the model can't reply. */
export function compareItemDisabled(on: boolean, count: number, max: number, a: LocalAvailability | undefined): boolean {
  return !on && (count >= max || availabilityLabel(a) !== null);
}

/** The composer's explanation for the first chosen model that can't reply; null when all can (or aren't known yet). */
export function unavailableReason(models: LibraryModel[], ids: string[], availability: Record<string, LocalAvailability>): string | null {
  for (const id of ids) {
    const state = availability[id];
    const m = models.find((x) => x.id === id);
    if (!m) continue;
    const server = m.serverName ?? 'The server';
    if (state === 'offline') return `${m.displayName} is offline.`;
    if (state === 'missing') return `${m.displayName} isn't installed on ${server} any more.`;
    if (state === 'off') return `${server} is turned off in Settings.`;
  }
  return null;
}
