import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsView } from '../../../shared/types';
import { api } from '../api';
import { htmlAttrs, loadAppearance, reconcileAppearance, rollbackAppearance, saveAppearance, type Appearance } from '../lib/appearance';

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
 * `onSaved` hands the server's view after each save to the owner of `settings`, so it never lags behind a change.
 */
export function useAppearance(settings: SettingsView | null, onSaved?: (view: SettingsView) => void) {
  const [appearance, setLocal] = useState<Appearance>(loadAppearance);
  /** Saves in flight: a settings fetch landing meanwhile may predate them, so it is ignored. */
  const pending = useRef(0);
  const systemDark = useMedia('(prefers-color-scheme: dark)');
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');

  const applyServer = useCallback((server: Appearance) => {
    setLocal((cur) => {
      const next = reconcileAppearance(cur, server, pending.current);
      if (next !== cur) saveAppearance(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (settings) applyServer(fromSettings(settings));
  }, [settings, applyServer]);

  const attrs = htmlAttrs(appearance, systemDark, reducedMotion);
  useEffect(() => {
    Object.assign(document.documentElement.dataset, attrs);
  }, [attrs.theme, attrs.accent, attrs.style, attrs.motion, attrs.tilt]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Applies at once, then saves; if the server refuses, puts back just the fields this change touched. */
  const setAppearance = useCallback(async (patch: Partial<Appearance>) => {
    const before: Record<string, unknown> = {};
    setLocal((cur) => {
      for (const key of Object.keys(patch) as (keyof Appearance)[]) before[key] = cur[key];
      const next = { ...cur, ...patch };
      saveAppearance(next);
      return next;
    });
    pending.current++;
    try {
      const view = await api.updateSettings(patch);
      pending.current--;
      onSaved?.(view);
      applyServer(fromSettings(view));
    } catch {
      pending.current--;
      setLocal((cur) => {
        const next = rollbackAppearance(cur, patch, before as Partial<Appearance>);
        if (next !== cur) saveAppearance(next);
        return next;
      });
    }
  }, [applyServer, onSaved]);

  return { appearance, setAppearance, systemDark, motionOn: attrs.motion === 'on', tiltOn: attrs.tilt === 'on' };
}
