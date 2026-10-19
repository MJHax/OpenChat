import { Check } from 'lucide-react';
import type { Accent, ColorStyle, Theme } from '../../../../shared/types';
import type { Appearance } from '../../lib/appearance';

export interface AppearanceTabProps {
  appearance: Appearance;
  onChange(patch: Partial<Appearance>): void;
}

const THEMES: { id: Theme; label: string }[] = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System' }];
const ACCENTS: { id: Accent; label: string }[] = [
  { id: 'blue', label: 'Blue' }, { id: 'orange', label: 'Orange' }, { id: 'green', label: 'Green' }, { id: 'rainbow', label: 'Rainbow' },
];
const STYLES: { id: ColorStyle; label: string; note: string }[] = [
  { id: 'flat', label: 'Flat', note: 'Solid accent, clean and quiet' },
  { id: 'vivid', label: 'Vivid', note: 'Drifting duotone, soft glow' },
];

/** Theme, accent color, color style and motion. Every choice applies at once. */
export function AppearanceTab({ appearance, onChange }: AppearanceTabProps) {
  const rainbow = appearance.accent === 'rainbow';
  return (
    <div className="appearance">
      <section>
        <h3>Theme</h3>
        <p className="hint">Mostly black and white, with your accent on the important bits.</p>
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} role="radio" aria-checked={appearance.theme === t.id} className={`choice-card${appearance.theme === t.id ? ' on' : ''}`}
              onClick={() => onChange({ theme: t.id })}>
              <span className={`theme-mini ${t.id}`}><i /><span><b className="fill" /></span></span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Accent color</h3>
        <p className="hint">Used for the send button, focus glow, active nav and highlights.</p>
        <div className="accent-cards" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((a) => (
            <button key={a.id} role="radio" aria-checked={appearance.accent === a.id} className={`accent-card${appearance.accent === a.id ? ' on' : ''}`}
              onClick={() => onChange({ accent: a.id })}>
              <span className={`accent-swatch sw-${a.id}`}><Check size={18} /></span>
              {a.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Color style</h3>
        <p className="hint">How much the accent shows up. Rainbow is always vivid.</p>
        <div className={`style-cards${rainbow ? ' locked' : ''}`} role="radiogroup" aria-label="Color style" aria-disabled={rainbow}>
          {STYLES.map((s) => (
            <button key={s.id} role="radio" aria-checked={appearance.colorStyle === s.id} disabled={rainbow}
              className={`choice-card${appearance.colorStyle === s.id ? ' on' : ''}`} onClick={() => onChange({ colorStyle: s.id })}>
              <span className={`style-prev ${s.id}`}>
                {s.id === 'vivid' && <span className="sp-glow" />}
                <span className="sp-btn" /><span className="sp-line" /><span className="sp-line short" />
              </span>
              <span><b>{s.label}</b><small>{s.note}</small></span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Motion</h3>
        <div className="toggle-row">
          <div>Animations<small>Springs, fades and the sliding nav indicator</small></div>
          <button role="switch" aria-checked={appearance.animations} aria-label="Animations" className="switch"
            onClick={() => onChange({ animations: !appearance.animations })} />
        </div>
        <div className="toggle-row">
          <div>Tilt cards<small>3D tilt and glare on library, gallery and suggestion cards</small></div>
          <button role="switch" aria-checked={appearance.tiltCards} aria-label="Tilt cards" className="switch"
            onClick={() => onChange({ tiltCards: !appearance.tiltCards })} />
        </div>
        <p className="hint">If your system asks for reduced motion, both stay off.</p>
      </section>
    </div>
  );
}
