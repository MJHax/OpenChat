import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Search } from 'lucide-react';
import type { SearchHit, ThreadKind } from '../../../../shared/types';
import { api } from '../../api';
import { splitSnippet } from '../../lib/format';
import { filterCommands, moveSelection, type PaletteCommand } from '../../lib/palette';

export interface CommandPaletteProps {
  onClose(): void;
  /** Runs a fixed command by id (navigation and appearance live in App). */
  onCommand(id: string): void;
  onOpenChat(chatId: string, kind: ThreadKind): void;
}

type Row = { kind: 'hit'; hit: SearchHit } | { kind: 'command'; command: PaletteCommand };

/** Ctrl/Cmd+K: search every chat, start something new, jump anywhere, change the look. */
export function CommandPalette({ onClose, onCommand, onOpenChat }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    setSearchFailed(false);
    if (!q) {
      setHits([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.search(q)
        .then((h) => { if (current) setHits(h.slice(0, 8)); })
        .catch(() => { if (current) { setHits([]); setSearchFailed(true); } });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [query]);

  const commands = filterCommands(query);
  const rows: Row[] = useMemo(
    () => [...hits.map((hit) => ({ kind: 'hit' as const, hit })), ...commands.map((command) => ({ kind: 'command' as const, command }))],
    [hits, commands.map((c) => c.id).join()], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => setIndex(0), [query, hits.length]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  async function run(row: Row | undefined) {
    if (!row) return;
    onClose();
    if (row.kind === 'command') return onCommand(row.command.id);
    await api.selectMessage(row.hit.chatId, row.hit.messageId).catch(() => {});
    onOpenChat(row.hit.chatId, row.hit.chatKind);
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => moveSelection(i, e.key === 'ArrowDown' ? 1 : -1, rows.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void run(rows[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  // Group headings in row order; a row's position in `rows` is its selection index.
  let n = -1;
  const groups: { title: string; rows: { row: Row; i: number }[] }[] = [];
  const push = (title: string, row: Row) => {
    n += 1;
    const g = groups.find((x) => x.title === title) ?? (groups.push({ title, rows: [] }), groups[groups.length - 1]);
    g.rows.push({ row, i: n });
  };
  for (const row of rows) push(row.kind === 'hit' ? 'Chats' : row.command.group, row);

  return (
    <div className="palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={16} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search chats or type a command…"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={rows.length ? `palette-row-${index}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {searchFailed && <div className="palette-group"><div className="palette-title">Chats</div><div className="muted small palette-note">Search failed</div></div>}
          {groups.map((g) => (
            <div key={g.title} className="palette-group" role="group" aria-label={g.title}>
              <div className="palette-title">{g.title}</div>
              {g.rows.map(({ row, i }) => (
                <button key={row.kind === 'hit' ? `h${row.hit.messageId}` : row.command.id} id={`palette-row-${i}`} data-row={i} role="option"
                  aria-selected={i === index} className={`palette-row${i === index ? ' on' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => void run(row)}>
                  {row.kind === 'hit' ? (
                    <>
                      <MessageSquare size={15} />
                      <span className="palette-hit">
                        <span>{row.hit.chatTitle}</span>
                        <small>{splitSnippet(row.hit.snippet).map((part, k) => (part.hit ? <mark key={k}>{part.text}</mark> : <span key={k}>{part.text}</span>))}</small>
                      </span>
                    </>
                  ) : (
                    <span>{row.command.label}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {rows.length === 0 && !searchFailed && <div className="muted palette-note">No results</div>}
        </div>
      </div>
    </div>
  );
}
