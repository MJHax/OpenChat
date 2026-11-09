export type RevealMode = 'natural' | 'instant';

export interface DiscussionPrefs {
  reveal: RevealMode;
  waitForMe: boolean;
}

export const DEFAULT_DISCUSSION_PREFS: DiscussionPrefs = { reveal: 'natural', waitForMe: false };

const KEY = 'openchat.discussionPrefs';

/** Saved pacing preferences; the defaults when nothing valid is saved or storage is unavailable. */
export function loadDiscussionPrefs(): DiscussionPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_DISCUSSION_PREFS };
    const v = JSON.parse(raw) as Partial<Record<keyof DiscussionPrefs, unknown>> | null;
    return {
      reveal: v?.reveal === 'natural' || v?.reveal === 'instant' ? v.reveal : DEFAULT_DISCUSSION_PREFS.reveal,
      waitForMe: typeof v?.waitForMe === 'boolean' ? v.waitForMe : DEFAULT_DISCUSSION_PREFS.waitForMe,
    };
  } catch {
    return { ...DEFAULT_DISCUSSION_PREFS };
  }
}

export function saveDiscussionPrefs(p: DiscussionPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage unavailable (private window); the choice just won't be remembered
  }
}
