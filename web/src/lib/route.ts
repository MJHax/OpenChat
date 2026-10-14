import { useMemo, useSyncExternalStore } from 'react';

export type Route = { page: 'chat'; chatId: string | null } | { page: 'models' } | { page: 'settings' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'models') return { page: 'models' };
  if (parts[0] === 'settings') return { page: 'settings' };
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
