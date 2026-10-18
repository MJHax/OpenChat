import { useEffect, useState } from 'react';
import type { LibraryModel, SettingsUpdate, SettingsView } from '../../../shared/types';
import { api } from '../api';
import type { SettingsTab } from '../lib/route';
import { GeneralTab } from './settings/GeneralTab';
import { MemoryTab } from './settings/MemoryTab';
import { DataTab } from './settings/DataTab';

export interface SettingsProps {
  models: LibraryModel[];
  tab: SettingsTab;
  /** An element id in the tab to scroll to, e.g. 'limits'. */
  section: string | null;
  onChanged(): void;
  /** Threads were deleted from the Data tab. */
  onDataChanged(): void;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'memory', label: 'Memory' },
  { id: 'data', label: 'Data' },
];

export function Settings({ models, tab, section, onChanged, onDataChanged }: SettingsProps) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.getSettings().then(setView).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

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

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Settings</h1>
        <nav className="settings-tabs" aria-label="Settings sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#/settings/${t.id}`} aria-current={t.id === tab ? 'page' : undefined}>{t.label}</a>
          ))}
        </nav>
        {error && <p className="error-text">{error}</p>}
        {tab === 'memory' ? <MemoryTab /> : !view ? (!error && <p className="muted">Loading…</p>) : tab === 'data' ? (
          <DataTab view={view} onDeleted={(all) => { onDataChanged(); if (all) { void load(); onChanged(); } }} />
        ) : (
          <GeneralTab view={view} models={models} section={section} update={update} />
        )}
      </div>
    </div>
  );
}
