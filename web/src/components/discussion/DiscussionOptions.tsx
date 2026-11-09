import { useId } from 'react';
import type { DiscussionPrefs, RevealMode } from '../../lib/discussionPrefs';

const REVEAL: { value: RevealMode; label: string; note: string }[] = [
  { value: 'natural', label: 'Naturally', note: 'Word by word, with a short pause after each reply' },
  { value: 'instant', label: 'Instantly', note: 'As fast as the model writes' },
];

const AFTER: { value: boolean; label: string; note: string }[] = [
  { value: false, label: 'Keep going', note: 'The next turn starts on its own' },
  { value: true, label: 'Wait for me', note: 'Press Next after each reply' },
];

/** The two pacing choices for a discussion: how replies appear, and whether the debate waits after each one. */
export function DiscussionOptions({ prefs, onChange }: { prefs: DiscussionPrefs; onChange(p: DiscussionPrefs): void }) {
  const name = useId();
  return (
    <div className="discussion-options">
      <fieldset role="radiogroup" aria-label="Show replies">
        <legend>Show replies</legend>
        {REVEAL.map((o) => (
          <label key={o.value} className="option-radio">
            <input type="radio" name={`${name}-reveal`} checked={prefs.reveal === o.value} onChange={() => onChange({ ...prefs, reveal: o.value })} />
            <span>{o.label}<small>{o.note}</small></span>
          </label>
        ))}
      </fieldset>
      <fieldset role="radiogroup" aria-label="After each reply">
        <legend>After each reply</legend>
        {AFTER.map((o) => (
          <label key={o.label} className="option-radio">
            <input type="radio" name={`${name}-after`} checked={prefs.waitForMe === o.value} onChange={() => onChange({ ...prefs, waitForMe: o.value })} />
            <span>{o.label}<small>{o.note}</small></span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
