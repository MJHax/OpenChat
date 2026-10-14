import type { LibraryModel } from '../../../shared/types';

export interface ModelLibraryProps {
  models: LibraryModel[];
  onChanged(): void;
}

export function ModelLibrary(_props: ModelLibraryProps) {
  return <div className="page">Model Library</div>;
}
