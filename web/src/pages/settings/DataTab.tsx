import { useEffect, useRef, useState } from 'react';
import type { DeleteTarget, SettingsView, StorageUsage } from '../../../../shared/types';
import { api } from '../../api';
import { formatBytes } from '../../lib/format';
import { forgetAllPrefs, forgetChatPrefs } from '../../lib/dataPrefs';

export interface DataTabProps {
  view: SettingsView;
  /** `all`: everything was reset, so settings must reload too. */
  onDeleted(all: boolean): void;
}

const PARTS: { key: keyof StorageUsage['parts']; label: string }[] = [
  { key: 'messages', label: 'Chat messages' },
  { key: 'discussions', label: 'Discussions' },
  { key: 'uploads', label: 'Uploaded attachments' },
  { key: 'images', label: 'Generated images' },
  { key: 'videos', label: 'Videos' },
  { key: 'reclaimable', label: 'Reclaimable (deleted content)' },
  { key: 'other', label: 'Indexes, stats and settings' },
];

const DELETES: { target: Exclude<DeleteTarget, 'all'>; button: string; title: string; body: string }[] = [
  {
    target: 'chats', button: 'Delete all chats', title: 'Delete all chats?',
    body: 'Every chat is deleted from disk, with its messages, attachments and generated files. Images, videos, memories, settings and stats stay.',
  },
  {
    target: 'images', button: 'Delete all images', title: 'Delete all images?',
    body: 'Every image thread is deleted from disk, with its images. Everything else stays.',
  },
  {
    target: 'videos', button: 'Delete all videos', title: 'Delete all videos?',
    body: 'Every video thread is deleted from disk, with its clip files. Everything else stays.',
  },
  {
    target: 'discussions', button: 'Delete all discussions', title: 'Delete all discussions?',
    body: "Every discussion and its transcript and summary will be deleted. This can't be undone.",
  },
];

const NOUN: Record<Exclude<DeleteTarget, 'all'>, string> = { chats: 'chat', images: 'image thread', videos: 'video thread', discussions: 'discussion' };

function StorageBar({ usage }: { usage: StorageUsage }) {
  const scale = Math.max(usage.total, 1);
  return (
    <div className="context-bar storage-bar" aria-hidden="true">
      {PARTS.map(({ key, label }) => usage.parts[key] > 0 && (
        <b key={key} className={`store-${key}`} style={{ width: `${(usage.parts[key] / scale) * 100}%` }} title={`${label}: ${formatBytes(usage.parts[key])}`} />
      ))}
    </div>
  );
}

function ConfirmDelete({ target, view, onClose, onDone }: {
  target: DeleteTarget; view: SettingsView; onClose(): void; onDone(chatIds: string[]): void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = DELETES.find((d) => d.target === target);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onDone((await api.deleteData(target, typed)).chatIds);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="confirm-delete-title">
        <h3 id="confirm-delete-title">{info ? info.title : 'Delete all my data?'}</h3>
        {info ? <p>{info.body}</p> : (
          <>
            <p>This puts OpenChat back to a fresh install. It deletes:</p>
            <ul className="small">
              <li>every chat, image and video, with all their files</li>
              <li>memories, saved prompts, About me and custom instructions</li>
              <li>the API key saved in Settings</li>
              <li>your model libraries and model choices, the theme and spending limits</li>
              <li><strong>stats and cost history</strong></li>
            </ul>
            {view.apiKeySource === 'env' && (
              <p className="small">Your API key comes from the <code>.env</code> file, which OpenChat doesn't own, so it stays. Remove it from that file yourself if you want it gone.</p>
            )}
          </>
        )}
        <p className="small"><strong>This can't be undone.</strong> Export first if you might want any of it.</p>
        <label className="field">
          Type DELETE to confirm
          <input type="text" aria-label="Type DELETE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="error-text small">{error}</p>}
        <div className="row">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="danger-button" onClick={confirm} disabled={typed !== 'DELETE' || busy}>{busy ? 'Deleting…' : info ? info.button : 'Delete all my data'}</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmImport({ file, onClose }: { file: File; onClose(): void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.importData(file, typed);
      forgetAllPrefs();
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="confirm-import-title">
        <h3 id="confirm-import-title">Replace everything with this backup?</h3>
        <p className="small"><strong>{file.name}</strong> · {formatBytes(file.size)}</p>
        <p>
          Every chat, image, video, discussion, memory, saved prompt, setting and stat here is replaced by the backup's.
          <strong> This can't be undone.</strong> Export first if you might want any of it.
        </p>
        <p className="small">Other open tabs and devices will show old data until you reload them.</p>
        <label className="field">
          Type REPLACE to confirm
          <input type="text" aria-label="Type REPLACE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="error-text small">{error}</p>}
        <div className="row">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="danger-button" onClick={confirm} disabled={typed !== 'REPLACE' || busy}>{busy ? 'Importing…' : 'Replace everything'}</button>
        </div>
      </div>
    </div>
  );
}

export function DataTab({ view, onDeleted }: DataTabProps) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [confirming, setConfirming] = useState<DeleteTarget | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => api.storage().then(setUsage).catch((e: Error) => setError(e.message));
  useEffect(() => { void refresh(); }, []);

  async function cleanUp() {
    setCleaning(true);
    setError(null);
    try {
      setUsage(await api.cleanUp());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCleaning(false);
    }
  }

  function deleted(target: DeleteTarget, chatIds: string[]) {
    setConfirming(null);
    if (target === 'all') forgetAllPrefs();
    else forgetChatPrefs(chatIds);
    setNote(target === 'all' ? 'All your data was deleted.' : `Deleted ${chatIds.length} ${NOUN[target]}${chatIds.length === 1 ? '' : 's'}.`);
    onDeleted(target === 'all');
    void refresh();
  }

  return (
    <>
      <h2>Storage</h2>
      <div className="card">
        {error && <p className="error-text small">{error}</p>}
        {!usage ? <span className="muted small">Measuring…</span> : (
          <>
            <div><strong>{formatBytes(usage.total)}</strong> <span className="muted">on disk</span></div>
            <StorageBar usage={usage} />
            <div className="storage-rows">
              {PARTS.map(({ key, label }) => (
                <div key={key} className="stats-pop-row">
                  <span><span className={`context-dot store-${key}`} />{label}</span>
                  <span>{formatBytes(usage.parts[key])}</span>
                </div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted small">Clean up gives the space of deleted content back to the disk.</span>
              <button onClick={cleanUp} disabled={cleaning}>{cleaning ? 'Working…' : 'Clean up'}</button>
            </div>
          </>
        )}
      </div>

      <h2>Export</h2>
      <div className="card">
        <div className="muted small">
          One .zip with each chat, image and video thread as a Markdown file, a JSON file with your data, every attachment, image and video,
          and a full backup that Import can restore. Your API keys are never included.
        </div>
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <a className="button-link" href="/api/data/export" download>Export all data</a>
        </div>
      </div>

      <h2>Import</h2>
      <div className="card">
        <div className="muted small">
          Replace everything in this OpenChat with a backup made by Export. Your API keys aren't in backups, so this OpenChat keeps its own.
        </div>
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <input ref={fileInput} type="file" accept=".zip,application/zip" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setImporting(f); }} />
          <button onClick={() => fileInput.current?.click()}>Import a backup…</button>
        </div>
      </div>

      <h2>Delete</h2>
      {note && <p className="small" role="status">{note}</p>}
      <div className="card">
        {DELETES.map((d) => (
          <div key={d.target} className="row data-delete-row">
            <span className="small">{d.body}</span>
            <button onClick={() => { setNote(null); setConfirming(d.target); }}>{d.button}…</button>
          </div>
        ))}
      </div>
      <div className="card danger-zone">
        <div className="row data-delete-row">
          <span className="small">
            <strong>Delete all my data.</strong> Everything goes, including stats and cost history: OpenChat is back to a fresh install.
          </span>
          <button className="danger-button" onClick={() => { setNote(null); setConfirming('all'); }}>Delete all my data…</button>
        </div>
      </div>

      {importing && <ConfirmImport file={importing} onClose={() => setImporting(null)} />}
      {confirming && (
        <ConfirmDelete target={confirming} view={view} onClose={() => setConfirming(null)} onDone={(ids) => deleted(confirming, ids)} />
      )}
    </>
  );
}
