import { ACCENTS, COLOR_STYLES, type Accent, type ColorStyle, type Theme } from '../../../shared/types';

/** How the app looks. The server stores it; the browser keeps a copy so the first frame is already right. */
export interface Appearance {
  theme: Theme;
  accent: Accent;
  colorStyle: ColorStyle;
  animations: boolean;
  tiltCards: boolean;
}

/** Read by the inline script in web/index.html too: keep the two in step. */
export const APPEARANCE_KEY = 'openchat.appearance';

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', accent: 'blue', colorStyle: 'vivid', animations: true, tiltCards: true };

const THEMES: Theme[] = ['light', 'dark', 'system'];

/** A stored copy, field by field: anything missing or invalid falls back to the default. */
export function parseAppearance(raw: string | null): Appearance {
  let v: unknown;
  try {
    v = raw === null ? null : JSON.parse(raw);
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_APPEARANCE };
  const o = v as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;
  return {
    theme: THEMES.includes(o.theme as Theme) ? (o.theme as Theme) : d.theme,
    accent: ACCENTS.includes(o.accent as Accent) ? (o.accent as Accent) : d.accent,
    colorStyle: COLOR_STYLES.includes(o.colorStyle as ColorStyle) ? (o.colorStyle as ColorStyle) : d.colorStyle,
    animations: typeof o.animations === 'boolean' ? o.animations : d.animations,
    tiltCards: typeof o.tiltCards === 'boolean' ? o.tiltCards : d.tiltCards,
  };
}

export function loadAppearance(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
  } catch {
    // storage unavailable (private window); the server copy still applies once it loads
  }
}

/** Rainbow has no flat version. */
export function effectiveStyle(a: Pick<Appearance, 'accent' | 'colorStyle'>): ColorStyle {
  return a.accent === 'rainbow' ? 'vivid' : a.colorStyle;
}

export function resolvedTheme(theme: Theme, systemDark: boolean): 'light' | 'dark' {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

/** The one-click toggle: the opposite of what is on screen, even when the setting is System. */
export function nextTheme(theme: Theme, systemDark: boolean): 'light' | 'dark' {
  return resolvedTheme(theme, systemDark) === 'dark' ? 'light' : 'dark';
}

/** The data-* attributes on <html> that the stylesheets key off. */
export function htmlAttrs(a: Appearance, systemDark: boolean, reducedMotion: boolean): Record<string, string> {
  return {
    theme: resolvedTheme(a.theme, systemDark),
    accent: a.accent,
    style: effectiveStyle(a),
    motion: a.animations && !reducedMotion ? 'on' : 'off',
    tilt: a.tiltCards && !reducedMotion ? 'on' : 'off',
  };
}
