import type { ReactNode } from 'react';
import { usePopover } from './usePopover';

export interface ChipPopoverProps {
  /** What the chip shows. */
  label: ReactNode;
  icon?: ReactNode;
  title: string;
  /** Which edge the popover lines up with. */
  align?: 'left' | 'right';
  /** Opens below the chip (header) or above it (composer). */
  placement?: 'up' | 'down';
  className?: string;
  panelClassName?: string;
  /** The popover's content; `close` shuts it. */
  children(close: () => void): ReactNode;
}

/** A chip that opens a popover springing out of its corner. Closes on outside click or Escape. */
export function ChipPopover({ label, icon, title, align = 'left', placement = 'up', className = '', panelClassName = '', children }: ChipPopoverProps) {
  const { open, setOpen, root } = usePopover();
  return (
    <div className="chip-pop" ref={root}>
      <button type="button" className={`chip ${className}`} title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        {icon}{label}
      </button>
      {open && (
        <div className={`popover${placement === 'down' ? ' down' : ''}${align === 'right' ? ' right' : ''} ${panelClassName}`} role="dialog" aria-label={title}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
