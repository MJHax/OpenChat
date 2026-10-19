import { useCallback, useEffect, useState } from 'react';
import type { SettingsView } from '../../../shared/types';
import { api } from '../api';
import { htmlAttrs, loadAppearance, saveAppearance, type Appearance } from '../lib/appearance';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}

const fromSettings = (s: SettingsView): Appearance => ({
  theme: s.theme, accent: s.accent, colorStyle: s.colorStyle, animations: s.animations, tiltCards: s.tiltCards,
});

/**
 * Keeps <html>'s data-* attributes in step with the appearance settings and the OS (dark mode, reduced motion).
 * Starts from the browser's copy, which web/index.html already applied, so nothing flashes while settings load.
 */
export function useAppearance(settings: SettingsView | null) {
  const [appearance, setLocal] = useState<Appearance>(loadAppearance);
  const systemDark = useMedia('(prefers-color-scheme: dark)');
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');

  useEffect(() => {
    if (!settings) return;
    const next = fromSettings(settings);
    setLocal(next);
    saveAppearance(next);
  }, [settings]);

  const attrs = htmlAttrs(appearance, systemDark, reducedMotion);
  useEffect(() => {
    Object.assign(document.documentElement.dataset, attrs);
  }, [attrs.theme, attrs.accent, attrs.style, attrs.motion, attrs.tilt]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Applies at once, then saves; puts the old look back if the server refuses. */
  const setAppearance = useCallback(async (patch: Partial<Appearance>) => {
    let before: Appearance | null = null;
    setLocal((cur) => {
      before = cur;
      const next = { ...cur, ...patch };
      saveAppearance(next);
      return next;
    });
    try {
      await api.updateSettings(patch);
    } catch {
      if (before) {
        setLocal(before);
        saveAppearance(before);
      }
    }
  }, []);

  return { appearance, setAppearance, systemDark, motionOn: attrs.motion === 'on', tiltOn: attrs.tilt === 'on' };
}
