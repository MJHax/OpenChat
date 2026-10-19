import { useEffect, useRef, useState } from 'react';
import { Brain, Database, Gauge, Palette, Settings2, X } from 'lucide-react';
import type { LibraryModel, SettingsUpdate, SettingsView } from '../../../shared/types';
import { api } from '../api';
import type { Appearance } from '../lib/appearance';
import type { SettingsTab } from '../lib/route';
import { closesOverlay } from '../lib/escape';
import { GeneralTab } from './settings/GeneralTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { MemoryTab } from './settings/MemoryTab';
import { DataTab } from './settings/DataTab';
import { LimitsTab } from './settings/LimitsTab';

export interface SettingsProps {
  models: LibraryModel[];
  tab: SettingsTab;
  /** An element id in the tab to scroll to. */
  section: string | null;
  appearance: Appearance;
  onAppearance(patch: Partial<Appearance>): void;
  onChanged(): void;
  /** Threads were deleted from the Data tab. */
  onDataChanged(): void;
  onClose(): void;
}

const TABS: { id: SettingsTab; label: string; Icon: typeof Settings2 }[] = [
  { id: 'general', label: 'General', Icon: Settings2 },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'memory', label: 'Memory', Icon: Brain },
  { id: 'data', label: 'Data', Icon: Database },
  { id: 'limits', label: 'Spending limits', Icon: Gauge },
];

/** Settings, as a sheet over the page it was opened from. */
export function Settings({ models, tab, section, appearance, onAppearance, onChanged, onDataChanged, onClose }: SettingsProps) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  const load = () => api.getSettings().then(setView).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  // Focus moves into the sheet (App puts it back on close); Escape closes.
  useEffect(() => {
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const nestedModalOpen = !!sheet.current?.querySelector('.modal-backdrop');
      if (closesOverlay({ key: e.key, isComposing: e.isComposing, defaultPrevented: e.defaultPrevented, targetTag: target?.tagName ?? '', nestedModalOpen })) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function update(patch: SettingsUpdate) {
    setError(null);
    try {
      setView(await api.updateSettings(patch));
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" ref={sheet} tabIndex={-1}>
        <nav className="settings-tabs" aria-label="Settings sections">
          <h2>Settings</h2>
          {TABS.map(({ id, label, Icon }) => (
            <a key={id} href={`#/settings/${id}`} aria-current={id === tab ? 'page' : undefined}><Icon size={15} />{label}</a>
          ))}
        </nav>
        <div className="settings-pane">
          <div className="settings-pane-head">
            <h1>{current.label}</h1>
            <button className="icon-btn" onClick={onClose} aria-label="Close settings" title="Close (Esc)"><X size={16} /></button>
          </div>
          {error && <p className="error-text">{error}</p>}
          {tab === 'appearance' ? <AppearanceTab appearance={appearance} onChange={onAppearance} />
            : tab === 'memory' ? <MemoryTab />
            : !view ? (!error && <p className="muted">Loading…</p>)
            : tab === 'data' ? <DataTab view={view} onDeleted={(all) => { onDataChanged(); if (all) { void load(); onChanged(); } }} />
            : tab === 'limits' ? <LimitsTab view={view} update={update} />
            : <GeneralTab view={view} models={models} section={section} update={update} />}
        </div>
      </div>
    </div>
  );
}
