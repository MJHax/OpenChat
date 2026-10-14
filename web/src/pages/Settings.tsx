import type { LibraryModel } from '../../../shared/types';

export interface SettingsProps {
  models: LibraryModel[];
  onChanged(): void;
}

export function Settings(_props: SettingsProps) {
  return <div className="page">Settings</div>;
}
