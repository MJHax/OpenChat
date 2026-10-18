import type { DB } from '../src/db';
import type { NewDiscussion } from '../../shared/types';

export function seedModel(db: DB, id: string, supportsTools: boolean) {
  db.prepare("INSERT INTO models (id, display_name, added_at, input_modalities, supports_tools) VALUES (?, ?, 0, '[\"text\"]', ?)")
    .run(id, id, supportsTools ? 1 : 0);
}

export const newDiscussion = (over: Partial<NewDiscussion> = {}): NewDiscussion => ({
  topic: '  Which came first, the chicken or the egg?  ',
  turnLimit: 10,
  participants: [
    { name: ' Egg-Defender ', modelId: 'test/tools', instructions: ' Argue the egg. ', isModerator: false },
    { name: 'Chicken-Defender', modelId: 'test/tools', instructions: 'Argue the chicken.', isModerator: false },
  ],
  ...over,
});

export const withModerator = (): NewDiscussion => newDiscussion({
  participants: [
    ...newDiscussion().participants,
    { name: 'Moderator', modelId: 'test/tools', instructions: 'Keep it fair.', isModerator: true },
  ],
});
