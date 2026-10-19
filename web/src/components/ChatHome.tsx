import { Code2, Image, PenLine, Users } from 'lucide-react';
import { greeting } from '../lib/greeting';
import { navigate } from '../lib/route';
import { TiltCard } from './TiltCard';

/** A mode's home heading, above the composer: the time of day, then a highlighted prompt and a one-line hint. */
export function HomeGreeting({ prompt = "What's next?", note = 'Ask anything, generate images or video, or set two models talking.' }: { prompt?: string; note?: string }) {
  return (
    <div className="home-greet">
      <h2>{greeting(new Date().getHours())} <em className="accent-text">{prompt}</em></h2>
      <p>{note}</p>
    </div>
  );
}

const CARDS = [
  { id: 'write', title: 'Write', note: 'Draft, rewrite or tighten anything', Icon: PenLine, prefill: 'Help me write ' },
  { id: 'code', title: 'Code', note: 'Debug, explain or build a feature', Icon: Code2, prefill: 'Help me debug this code:\n\n' },
  { id: 'imagine', title: 'Imagine', note: 'Generate or edit an image', Icon: Image, href: '#/images' },
  { id: 'discuss', title: 'Discuss', note: 'Let models debate a topic', Icon: Users, href: '#/discussions' },
] as const;

/** Starting points under the composer: two prefill it, two jump to another mode. */
export function SuggestionCards({ onPrefill }: { onPrefill(text: string): void }) {
  return (
    <div className="suggest">
      {CARDS.map((c) => (
        <TiltCard key={c.id} as="button" type="button" className="sugg" max={14}
          onClick={() => ('href' in c ? navigate(c.href) : onPrefill(c.prefill))}>
          <span className="sugg-icon"><c.Icon size={16} /></span>
          <b>{c.title}</b>
          <span className="sugg-note">{c.note}</span>
        </TiltCard>
      ))}
    </div>
  );
}
