import { useEffect, useState } from 'react';
import type { DiscussionDetail, LibraryModel, SettingsView } from '../../../shared/types';
import { api } from '../api';
import { navigate } from '../lib/route';
import { DiscussionSetup } from '../components/discussion/DiscussionSetup';
import { DiscussionView } from '../components/discussion/DiscussionView';

export interface DiscussionPageProps {
  discussionId: string | null;
  models: LibraryModel[];
  settings: SettingsView | null;
  onDiscussionsChanged(): void;
}

// A discussion created on this page starts running when its page opens; one opened later waits for Resume.
const justCreated = new Map<string, DiscussionDetail>();

export function DiscussionPage({ discussionId, models, settings, onDiscussionsChanged }: DiscussionPageProps) {
  const [detail, setDetail] = useState<DiscussionDetail | null>(() => (discussionId ? justCreated.get(discussionId) ?? null : null));
  // Read here, forgotten in an effect: React may call state initializers twice in development.
  const [fresh] = useState(() => (discussionId ? justCreated.has(discussionId) : false));
  useEffect(() => {
    if (discussionId) justCreated.delete(discussionId);
  }, [discussionId]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!discussionId || detail) return;
    api.getDiscussion(discussionId).then(setDetail).catch((e: Error) => setError(e.message));
  }, [discussionId, detail]);

  if (!discussionId) {
    return (
      <DiscussionSetup models={models} noKey={!!settings && !settings.hasApiKey} onCreated={(d) => {
        justCreated.set(d.chat.id, d);
        onDiscussionsChanged();
        navigate(`#/discussions/${d.chat.id}`);
      }} />
    );
  }
  if (error) return <div className="page"><div className="page-inner"><p className="error-text">{error}</p></div></div>;
  if (!detail) return <div className="page"><div className="page-inner muted">Loading…</div></div>;
  return <DiscussionView initial={detail} justCreated={fresh} models={models} onChanged={onDiscussionsChanged} />;
}
