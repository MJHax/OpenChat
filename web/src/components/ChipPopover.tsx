import { useLayoutEffect, useState, type ReactNode } from 'react';
import { usePopover } from './usePopover';

export interface ChipPopoverProps {
  /** What the chip shows. */
  label: ReactNode;
  icon?: ReactNode;
  title: string;
  /** Which edge the popover lines up with. */
  align?: 'left' | 'right';
  /** Preferred side: below the chip (header) or above it (composer). Flips when the other side has more room. */
  placement?: 'up' | 'down';
  className?: string;
  panelClassName?: string;
  /** The popover's content; `close` shuts it. */
  children(close: () => void): ReactNode;
}

const MARGIN = 12;

/** A chip that opens a popover springing out of its corner. Closes on outside click or Escape. */
export function ChipPopover({ label, icon, title, align = 'left', placement = 'up', className = '', panelClassName = '', children }: ChipPopoverProps) {
  const { open, setOpen, root } = usePopover();
  const [fit, setFit] = useState<{ down: boolean; maxHeight: number } | null>(null);

  // Open on the side with room, never past the window edge.
  useLayoutEffect(() => {
    if (!open) return;
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.top - MARGIN - 8;
    const below = window.innerHeight - r.bottom - MARGIN - 8;
    const down = placement === 'down' ? below >= 200 || below >= above : above < 200 && below > above;
    setFit({ down, maxHeight: Math.max(120, Math.min(360, down ? below : above)) });
  }, [open, placement, root]);

  return (
    <div className="chip-pop" ref={root}>
      <button type="button" className={`chip ${className}`} title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        {icon}{label}
      </button>
      {open && (
        <div className={`popover${(fit?.down ?? placement === 'down') ? ' down' : ''}${align === 'right' ? ' right' : ''} ${panelClassName}`} role="dialog" aria-label={title}
          style={fit ? { maxHeight: fit.maxHeight, overflowY: 'auto' } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
