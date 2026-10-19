import { useLayoutEffect, useRef, useState } from 'react';
import { BarChart3, Box, Image, Library as LibraryIcon, MessageSquare, Moon, Settings, Sun, Users, Video } from 'lucide-react';
import type { ThreadKind } from '../../../../shared/types';
import { navigate, threadHome } from '../../lib/route';

export type RailItem = ThreadKind | 'models' | 'stats' | 'library' | 'settings';

export interface IconRailProps {
  active: RailItem;
  /** The thread mode the panel shows, so clicking it again toggles the panel. */
  mode: ThreadKind;
  resolvedTheme: 'light' | 'dark';
  onToggleTheme(): void;
  onTogglePanel(): void;
  settingsHref: string;
}

const MODES: { id: ThreadKind; label: string; Icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chats', Icon: MessageSquare },
  { id: 'image', label: 'Images', Icon: Image },
  { id: 'video', label: 'Video', Icon: Video },
  { id: 'discussion', label: 'Discussions', Icon: Users },
];

/** The thin column of icons on the far left: modes, library, stats, theme and settings. */
export function IconRail({ active, mode, resolvedTheme, onToggleTheme, onTogglePanel, settingsHref }: IconRailProps) {
  const rail = useRef<HTMLElement>(null);
  const [top, setTop] = useState<number | null>(null);

  // One indicator slides to whichever item is active.
  useLayoutEffect(() => {
    const btn = rail.current?.querySelector<HTMLElement>(`[data-rail="${active}"]`);
    setTop(btn ? btn.offsetTop : null);
  }, [active]);

  const item = (id: RailItem, label: string, Icon: typeof MessageSquare, onClick: () => void) => (
    <button key={id} className={`rail-btn${active === id ? ' on' : ''}`} data-rail={id} aria-label={label}
      aria-current={active === id ? 'page' : undefined} onClick={onClick}>
      <Icon size={18} />
      <span className="rail-tip" aria-hidden>{label}</span>
    </button>
  );

  return (
    <nav className="rail" ref={rail} aria-label="Main">
      <a className="rail-logo fill" href="#/" aria-label="OpenChat home">O</a>
      {top !== null && <span className="rail-ind" style={{ top }} aria-hidden />}
      {MODES.map(({ id, label, Icon }) => item(id, label, Icon, () => (id === mode && active === id ? onTogglePanel() : navigate(threadHome(id)))))}
      <span className="rail-sep" />
      {item('models', 'Model Library', Box, () => navigate('#/models'))}
      {item('stats', 'Stats', BarChart3, () => navigate('#/stats'))}
      {item('library', 'Library', LibraryIcon, () => navigate('#/library'))}
      <span className="rail-spacer" />
      <button className="rail-btn" aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={onToggleTheme}>
        {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        <span className="rail-tip" aria-hidden>{resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
      </button>
      {item('settings', 'Settings', Settings, () => navigate(settingsHref))}
    </nav>
  );
}
