import type { DiscussionPrefs } from '../../lib/discussionPrefs';

/** The two pacing choices for a discussion, as switches: whether replies are typed out, and whether the debate waits after each one. */
export function DiscussionOptions({ prefs, onChange }: { prefs: DiscussionPrefs; onChange(p: DiscussionPrefs): void }) {
  const typeOut = prefs.reveal === 'natural';
  return (
    <div className="discussion-options">
      <div className="toggle-row">
        <div>Type out replies<small>Word by word, with a short pause after each. Off shows them as fast as the model writes.</small></div>
        <button role="switch" aria-checked={typeOut} aria-label="Type out replies" className="switch"
          onClick={() => onChange({ ...prefs, reveal: typeOut ? 'instant' : 'natural' })} />
      </div>
      <div className="toggle-row">
        <div>Pause after each reply<small>Press Next to start the next turn</small></div>
        <button role="switch" aria-checked={prefs.waitForMe} aria-label="Pause after each reply" className="switch"
          onClick={() => onChange({ ...prefs, waitForMe: !prefs.waitForMe })} />
      </div>
    </div>
  );
}
