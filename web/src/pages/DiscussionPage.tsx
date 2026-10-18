import type { LibraryModel, SettingsView } from '../../../shared/types';

export interface DiscussionPageProps {
  discussionId: string | null;
  models: LibraryModel[];
  settings: SettingsView | null;
  onDiscussionsChanged(): void;
}

export function DiscussionPage(_props: DiscussionPageProps) {
  return <div className="discussion-page">Discussion</div>;
}
