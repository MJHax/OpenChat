import { useMemo, useSyncExternalStore } from 'react';
import type { ThreadKind } from '../../../shared/types';

export type SettingsTab = 'general' | 'appearance' | 'memory' | 'data' | 'limits';
export const SETTINGS_TABS: SettingsTab[] = ['general', 'appearance', 'memory', 'data', 'limits'];

export type Route =
  | { page: 'chat'; chatId: string | null }
  | { page: 'images'; threadId: string | null }
  | { page: 'video'; threadId: string | null }
  | { page: 'discussions'; discussionId: string | null }
  | { page: 'models' }
  | { page: 'stats' }
  | { page: 'library' }
  /** `section` is an element id inside the tab to scroll to, e.g. `#/settings/general/limits`. */
  | { page: 'settings'; tab: SettingsTab; section: string | null };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'images') return { page: 'images', threadId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'video') return { page: 'video', threadId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'discussions') return { page: 'discussions', discussionId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'models') return { page: 'models' };
  if (parts[0] === 'settings') {
    // Spending limits used to be a section of General.
    if (parts[1] === 'general' && parts[2] === 'limits') return { page: 'settings', tab: 'limits', section: null };
    const tab = SETTINGS_TABS.find((t) => t === parts[1]);
    return { page: 'settings', tab: tab ?? 'general', section: tab && parts[2] ? decodeURIComponent(parts[2]) : null };
  }
  if (parts[0] === 'stats') return { page: 'stats' };
  if (parts[0] === 'library') return { page: 'library' };
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

/** Moves to `hash` without adding a history entry, so Back skips it. Fires hashchange like navigate does. */
export function replaceHash(hash: string): void {
  window.location.replace(hash);
}

const HOME: Record<ThreadKind, string> = { chat: '#/', image: '#/images', video: '#/video', discussion: '#/discussions' };
export const threadHome = (kind: ThreadKind) => HOME[kind];
export const threadHref = (kind: ThreadKind, id: string) => (kind === 'chat' ? `#/chat/${id}` : `${HOME[kind]}/${id}`);

/** The page Settings shows over: where it was opened from, or the chat home after a fresh load. */
export function settingsBackdrop(prev: Route | null): Route {
  return prev && prev.page !== 'settings' ? prev : { page: 'chat', chatId: null };
}

/**
 * How closing Settings returns to the backdrop. Settings holds one history entry (tab switches replace it), so when it
 * was opened from another page in this session Back lands exactly there; after a fresh load on a Settings URL there is
 * nothing in-app behind it, and going back could leave the app, so the entry is replaced instead.
 */
export function settingsCloseAction(prev: Route | null): 'back' | 'replace' {
  return prev && prev.page !== 'settings' ? 'back' : 'replace';
}

/** The hash that opens `route`; the inverse of parseHash. */
export function routeHash(route: Route): string {
  const id = (v: string | null) => (v ? `/${encodeURIComponent(v)}` : '');
  switch (route.page) {
    case 'chat': return route.chatId ? `#/chat/${encodeURIComponent(route.chatId)}` : '#/';
    case 'images': return `#/images${id(route.threadId)}`;
    case 'video': return `#/video${id(route.threadId)}`;
    case 'discussions': return `#/discussions${id(route.discussionId)}`;
    case 'models': return '#/models';
    case 'stats': return '#/stats';
    case 'library': return '#/library';
    case 'settings': return `#/settings/${route.tab}${id(route.section)}`;
  }
}
