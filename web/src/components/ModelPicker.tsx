import { Check, ChevronDown, X } from 'lucide-react';
import type { LibraryModel } from '../../../shared/types';
import { MAX_COMPARE, toggleModel, type CompareState } from '../lib/compare';
import { formatContext, formatPricePerM } from '../lib/format';
import { ChipPopover } from './ChipPopover';

export interface ModelPickerProps {
  models: LibraryModel[];
  modelId: string;
  onModelChange(id: string): void;
  compare: CompareState;
  onCompareChange(next: CompareState): void;
}

const details = (m: LibraryModel) =>
  [m.promptPrice !== null && `${formatPricePerM(m.promptPrice)} in · ${formatPricePerM(m.completionPrice)} out`, formatContext(m.contextLength) && `${formatContext(m.contextLength)} context`]
    .filter(Boolean).join(' · ');

/** The composer's model chip: one model normally, several (with a way out) in compare mode. */
export function ModelPicker({ models, modelId, onModelChange, compare, onCompareChange }: ModelPickerProps) {
  if (models.length === 0) return <span className="chip ghost">No models</span>;

  if (compare.enabled) {
    const chosen = models.filter((m) => compare.modelIds.includes(m.id));
    const label = chosen.length === 0 ? 'Pick models to compare' : chosen.length <= 2 ? chosen.map((m) => m.displayName).join(' vs ') : `${chosen.length} models`;
    return (
      <div className="compare-chip">
        <ChipPopover title="Models to compare" label={<>{label}<ChevronDown size={12} /></>} icon={<span className="mdot fill" />} className="model-chip">
          {() => (
            <>
              <div className="pop-label">Compare up to {MAX_COMPARE}</div>
              {models.map((m) => {
                const on = compare.modelIds.includes(m.id);
                return (
                  <button key={m.id} className={`pop-item${on ? ' sel' : ''}`} disabled={!on && compare.modelIds.length >= MAX_COMPARE}
                    role="menuitemcheckbox" aria-checked={on} onClick={() => onCompareChange(toggleModel(compare, m.id))}>
                    <span>{m.displayName}<small>{details(m)}</small></span>
                    {on && <Check size={15} className="check" />}
                  </button>
                );
              })}
            </>
          )}
        </ChipPopover>
        <button className="compare-off" aria-label="Turn off compare" title="Turn off compare" onClick={() => onCompareChange({ ...compare, enabled: false })}>
          <X size={12} />
        </button>
      </div>
    );
  }

  const current = models.find((m) => m.id === modelId);
  return (
    <ChipPopover title="Model" label={<>{current?.displayName ?? 'Choose a model'}<ChevronDown size={12} /></>} icon={<span className="mdot fill" />} className="model-chip">
      {(close) => (
        <>
          <div className="pop-label">Your models</div>
          {models.map((m) => (
            <button key={m.id} className={`pop-item${m.id === modelId ? ' sel' : ''}`} role="menuitemradio" aria-checked={m.id === modelId}
              onClick={() => { onModelChange(m.id); close(); }}>
              <span>{m.displayName}<small>{details(m)}</small></span>
              {m.id === modelId && <Check size={15} className="check" />}
            </button>
          ))}
        </>
      )}
    </ChipPopover>
  );
}
