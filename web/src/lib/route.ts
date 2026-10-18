import { useMemo, useSyncExternalStore } from 'react';

export type SettingsTab = 'general' | 'memory' | 'data';
const SETTINGS_TABS: SettingsTab[] = ['general', 'memory', 'data'];

export type Route =
  | { page: 'chat'; chatId: string | null }
  | { page: 'images'; threadId: string | null }
  | { page: 'video'; threadId: string | null }
  | { page: 'discussions'; discussionId: string | null }
  | { page: 'models' }
  | { page: 'stats' }
  /** `section` is an element id inside the tab to scroll to, e.g. `#/settings/general/limits`. */
  | { page: 'settings'; tab: SettingsTab; section: string | null };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'images') return { page: 'images', threadId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'video') return { page: 'video', threadId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'discussions') return { page: 'discussions', discussionId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'models') return { page: 'models' };
  if (parts[0] === 'settings') {
    const tab = SETTINGS_TABS.find((t) => t === parts[1]);
    return { page: 'settings', tab: tab ?? 'general', section: tab && parts[2] ? decodeURIComponent(parts[2]) : null };
  }
  if (parts[0] === 'stats') return { page: 'stats' };
  if (parts[0] === 'chat' && parts[1]) return { page: 'chat', chatId: decodeURIComponent(parts[1]) };
  return { page: 'chat', chatId: null };
}

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseHash(hash), [hash]);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}
