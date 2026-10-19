import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  ids: string[];
  index: number;
  disabled: boolean;
  onSelect(id: string): void;
}

export function SiblingNav({ ids, index, disabled, onSelect }: Props) {
  return (
    <span className="sibling-nav">
      <button className="link" disabled={disabled || index <= 0} onClick={() => onSelect(ids[index - 1])} aria-label="Previous version"><ChevronLeft size={14} /></button>
      <span>{index + 1}/{ids.length}</span>
      <button className="link" disabled={disabled || index >= ids.length - 1} onClick={() => onSelect(ids[index + 1])} aria-label="Next version"><ChevronRight size={14} /></button>
    </span>
  );
}
