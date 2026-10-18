import { useEffect, useState } from 'react';
import type { Attachment, GeneratedItems } from '../../../shared/types';
import { api, attachmentUrl } from '../api';
import { formatBytes } from '../lib/format';
import { filterGenerated, needsShrinking } from '../lib/generated';
import { shrinkImage } from '../lib/shrinkImage';

interface Props {
  /** Copies that are ready to send. */
  onAttachments(list: Attachment[]): void;
  /** Images too big to attach as they are, shrunk in the browser and uploaded like any file. */
  onFiles(files: File[]): void;
  onClose(): void;
}

const fileKey = (f: GeneratedItems['files'][number]) => `${f.messageId}/${f.name}`;

/** "From my chats": images made in the Images tab and files generated in chats, to attach to this message. */
export function GeneratedPicker({ onAttachments, onFiles, onClose }: Props) {
  const [items, setItems] = useState<GeneratedItems | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => { api.generated().then(setItems).catch((e: Error) => setError(e.message)); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (key: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  async function attach() {
    if (!items) return;
    setWorking(true);
    setError(null);
    try {
      const copies: Attachment[] = [];
      const big: File[] = [];
      for (const img of items.images.filter((i) => picked.has(i.attachmentId))) {
        const blob = await (await fetch(attachmentUrl(img.attachmentId))).blob();
        if (needsShrinking(blob.size)) big.push(new File([await shrinkImage(blob)], `${img.threadTitle || 'image'}.jpg`, { type: 'image/jpeg' }));
        else copies.push(await api.copyGenerated({ attachmentId: img.attachmentId }));
      }
      for (const f of items.files.filter((x) => picked.has(fileKey(x)))) copies.push(await api.copyGenerated({ messageId: f.messageId, name: f.name }));
      if (copies.length) onAttachments(copies);
      if (big.length) onFiles(big);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }

  const shown = items && filterGenerated(items, query);
  return (
    <div className="lightbox picker-backdrop" role="dialog" aria-label="Attach from my chats" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>From my chats</strong>
          <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search generated items" autoFocus />
        </div>
        {error && <p className="error-text small">{error}</p>}
        {!shown ? <p className="muted small">Loading…</p> : (
          <div className="picker-body">
            <h4>Images</h4>
            {shown.images.length === 0 ? <p className="muted small">No generated images{query ? ' match' : ' yet'}.</p> : (
              <div className="picker-grid">
                {shown.images.map((i) => (
                  <button key={i.attachmentId} className={`picker-image${picked.has(i.attachmentId) ? ' on' : ''}`} aria-pressed={picked.has(i.attachmentId)}
                    title={i.threadTitle} onClick={() => toggle(i.attachmentId)}>
                    <img src={attachmentUrl(i.attachmentId)} alt={i.threadTitle} />
                  </button>
                ))}
              </div>
            )}
            <h4>Files</h4>
            {shown.files.length === 0 ? <p className="muted small">No generated files{query ? ' match' : ' yet'}.</p> : (
              <ul className="picker-files">
                {shown.files.map((f) => (
                  <li key={fileKey(f)}>
                    <label>
                      <input type="checkbox" checked={picked.has(fileKey(f))} onChange={() => toggle(fileKey(f))} />
                      <span>{f.name}</span>
                      <span className="muted small">{f.chatTitle} · {formatBytes(f.size)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="picker-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={picked.size === 0 || working} onClick={() => { void attach(); }}>
            {working ? 'Attaching…' : `Attach${picked.size ? ` ${picked.size}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
