import type { SettingsUpdate, SettingsView } from '../../../../shared/types';
import { SpendingLimitsSection } from './SpendingLimitsSection';

/** Spending limits, which used to be a section of General. */
export function LimitsTab({ view, update }: { view: SettingsView; update(patch: SettingsUpdate): Promise<boolean> }) {
  return <SpendingLimitsSection limits={view.spendingLimits} update={update} />;
}
