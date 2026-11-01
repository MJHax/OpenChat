import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { SavedPrompt } from '../../../shared/types';
import { api } from '../api';
import { writeClipboard } from '../lib/clipboard';
import { closesOverlay } from '../lib/escape';
import { fillSlots, matchesPrompt, promptLabel, promptSlots, slotValue } from '../lib/prompts';
import { ErrorText } from './ErrorText';

export interface PromptsWindowProps {
  /** Whether a chat message box is behind the window to insert into. */
  canInsert: boolean;
  onInsert(text: string): void;
  onStartChat(text: string): void;
  onClose(): void;
}

/** What the right pane is editing: a new prompt, an existing one, or nothing. */
type Editing = { id: number | null; title: string; content: string } | null;

/** Saved prompts: a sheet over the page, like Settings, to keep reusable prompts and drop them into a chat. */
export function PromptsWindow({ canInsert, onInsert, onStartChat, onClose }: PromptsWindowProps) {
  const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listPrompts().then((list) => { setPrompts(list); setSelectedId((id) => id ?? list[0]?.id ?? null); }).catch((e: Error) => setError(e.message));
  }, []);

  const selected = prompts?.find((p) => p.id === selectedId) ?? null;
  const dirty = !!editing && (editing.id === null
    ? !!(editing.title.trim() || editing.content.trim())
    : editing.title !== selected?.title || editing.content !== selected?.content);
  /** Unsaved edits are only dropped once the user says so. */
  const leaveEditor = () => {
    if (dirty && !window.confirm('Discard changes?')) return false;
    setEditing(null);
    return true;
  };
  const leaveRef = useRef(leaveEditor);
  leaveRef.current = leaveEditor;
  const close = () => { if (leaveRef.current()) onClose(); };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Focus moves into the sheet (App puts it back on close); Escape closes, even from a text field: unsaved edits are asked about first.
  useEffect(() => {
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (closesOverlay({ key: e.key, isComposing: e.isComposing, defaultPrevented: e.defaultPrevented, targetTag: '', nestedModalOpen: false })) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(() => (prompts ?? []).filter((p) => matchesPrompt(p, query)), [prompts, query]);
  const slots = selected ? promptSlots(selected.content) : [];
  const filled = selected ? fillSlots(selected.content, values) : '';

  const select = (id: number) => {
    if (id === selectedId && !editing) return;
    if (!leaveEditor()) return;
    setSelectedId(id);
    setValues({});
  };

  async function save() {
    if (!editing) return;
    setError(null);
    try {
      const body = { title: editing.title, content: editing.content };
      const saved = editing.id === null ? await api.addPrompt(body) : await api.updatePrompt(editing.id, body);
      setPrompts((list) => [saved, ...(list ?? []).filter((p) => p.id !== saved.id)]);
      setSelectedId(saved.id);
      setValues({});
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(p: SavedPrompt) {
    if (!window.confirm(`Delete "${promptLabel(p)}"?`)) return;
    setError(null);
    try {
      await api.deletePrompt(p.id);
      const rest = (prompts ?? []).filter((x) => x.id !== p.id);
      setPrompts(rest);
      setSelectedId(rest[0]?.id ?? null);
      setValues({});
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copy() {
    try {
      await writeClipboard(filled);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy to the clipboard.");
    }
  }

  const startNew = () => { if (leaveEditor()) setEditing({ id: null, title: '', content: '' }); };

  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="settings-sheet prompts-sheet" role="dialog" aria-modal="true" aria-label="Saved prompts" ref={sheet} tabIndex={-1}>
        <nav className="prompts-list" aria-label="Your saved prompts">
          <div className="prompts-list-head">
            <h2>Saved prompts</h2>
            <button className="icon-btn" onClick={startNew} aria-label="New prompt" title="New prompt"><Plus size={16} /></button>
          </div>
          <label className="prompts-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts…" aria-label="Search prompts" />
          </label>
          {shown.map((p) => (
            <button key={p.id} className={`pop-item prompts-item${p.id === selectedId ? ' sel' : ''}`} aria-current={p.id === selectedId ? 'true' : undefined}
              onClick={() => select(p.id)}>
              <span>{promptLabel(p)}<small>{p.title ? p.content.split('\n')[0] : p.content.split('\n').slice(1).find((l) => l.trim()) ?? ''}</small></span>
            </button>
          ))}
          {prompts && prompts.length > 0 && shown.length === 0 && <p className="muted small prompts-none">No prompts match.</p>}
        </nav>

        <div className="settings-pane prompts-pane">
          <div className="settings-pane-head">
            <h1>{editing ? (editing.id === null ? 'New prompt' : 'Edit prompt') : selected ? promptLabel(selected) : 'Saved prompts'}</h1>
            <span className="prompts-head-actions">
              {selected && !editing && (
                <>
                  <button className="icon-btn" onClick={() => setEditing({ id: selected.id, title: selected.title, content: selected.content })}
                    aria-label="Edit prompt" title="Edit"><Pencil size={15} /></button>
                  <button className="icon-btn" onClick={() => void remove(selected)} aria-label="Delete prompt" title="Delete"><Trash2 size={15} /></button>
                </>
              )}
              <button className="icon-btn" onClick={close} aria-label="Close saved prompts" title="Close (Esc)"><X size={16} /></button>
            </span>
          </div>
          {error && <p className="error-text"><ErrorText message={error} /></p>}

          {editing ? (
            <div className="prompts-editor">
              <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Title (optional)" aria-label="Title" autoFocus />
              <textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} aria-label="Prompt"
                placeholder="Write the prompt. Use {{name}} for a part you fill in each time, like {{file}}." />
              <div className="prompts-actions">
                <button onClick={leaveEditor}>Cancel</button>
                <button className="primary" onClick={() => void save()} disabled={!editing.content.trim()}>Save</button>
              </div>
            </div>
          ) : selected ? (
            <div className="prompts-detail">
              <pre className="prompts-text">{selected.content}</pre>
              {slots.map((name) => (
                <label key={name} className="prompts-slot">
                  <span>{name}</span>
                  <input value={slotValue(values, name)} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} placeholder={`{{${name}}}`} />
                </label>
              ))}
              <div className="prompts-actions">
                <button className="link prompts-copy" onClick={() => void copy()}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
                <button onClick={() => onStartChat(filled)}>Start new chat</button>
                <button className="primary" onClick={() => onInsert(filled)} disabled={!canInsert}
                  title={canInsert ? 'Add it to the message box' : 'Open a chat to insert into its message box.'}>Insert into message</button>
              </div>
            </div>
          ) : prompts && prompts.length === 0 ? (
            <div className="prompts-empty">
              <p className="muted">No saved prompts yet.</p>
              <button className="primary" onClick={startNew}><Plus size={14} /> New</button>
            </div>
          ) : (
            !error && <p className="muted">{prompts ? 'Pick a prompt.' : 'Loading…'}</p>
          )}
        </div>
      </div>
    </div>
  );
}
