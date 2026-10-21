import { useEffect, useState } from 'react';
import { SERVER_TYPE_NAMES, type LocalServerType } from '../../../../shared/localModels';
import type { LocalServerStatus } from '../../../../shared/types';
import { api } from '../../api';
import { defaultAddress, defaultName, statusLabel } from '../../lib/localServers';

const TYPES: LocalServerType[] = ['ollama', 'lmstudio', 'openai'];

export function LocalServersCard() {
  const [servers, setServers] = useState<LocalServerStatus[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<LocalServerType>('ollama');
  const [name, setName] = useState(defaultName('ollama'));
  const [address, setAddress] = useState(defaultAddress('ollama'));
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editAddress, setEditAddress] = useState('');

  useEffect(() => {
    api.localServers().then(setServers).catch((e: Error) => setError(e.message));
  }, []);

  async function run(action: () => Promise<LocalServerStatus[]>): Promise<boolean> {
    setError('');
    setNote('');
    try {
      setServers(await action());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  function pickType(next: LocalServerType) {
    setType(next);
    setName(defaultName(next));
    setAddress(defaultAddress(next));
  }

  function openAdd() {
    pickType('ollama');
    setAddError('');
    setAdding(true);
  }

  async function save() {
    setBusy(true);
    setAddError('');
    try {
      setServers(await api.addLocalServer({ type, name: name.trim(), baseUrl: address.trim() }));
      setAdding(false);
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(s: LocalServerStatus) {
    setEditId(s.id);
    setEditName(s.name);
    setEditAddress(s.baseUrl);
  }

  async function saveEdit(id: string) {
    if (await run(() => api.updateLocalServer(id, { name: editName.trim(), baseUrl: editAddress.trim() }))) setEditId(null);
  }

  async function detect() {
    setBusy(true);
    const before = servers.length;
    await run(async () => {
      const list = await api.detectLocalServers();
      if (list.length <= before) setNote('No new local servers found.');
      return list;
    });
    setBusy(false);
  }

  return (
    <div className="card">
      <strong>Local servers</strong>
      <div className="muted small">Run models on this computer with Ollama, LM Studio, or any OpenAI-compatible server.</div>
      {servers.map((s) => (
        <div key={s.id} className="local-server">
          {editId === s.id ? (
            <div className="row" style={{ justifyContent: 'flex-start' }}>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="Server name" style={{ flex: 1 }} />
              <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} aria-label="Server address" style={{ flex: 1 }} />
              <button className="primary" onClick={() => saveEdit(s.id)} disabled={!editName.trim() || !editAddress.trim()}>Save</button>
              <button onClick={() => setEditId(null)}>Cancel</button>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div><strong>{s.name}</strong> <span className="muted small">{s.baseUrl} · {SERVER_TYPE_NAMES[s.type]}</span></div>
                <div className="muted small" title={s.error ?? undefined}>{statusLabel(s)}</div>
              </div>
              <div className="row">
                <button className="link" onClick={() => startEdit(s)}>Edit</button>
                <button className="link" onClick={() => run(() => api.updateLocalServer(s.id, { enabled: !s.enabled }))}>
                  {s.enabled ? 'Turn off' : 'Turn on'}
                </button>
                <button className="link danger" onClick={() => run(() => api.removeLocalServer(s.id))}>Remove</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {servers.length === 0 && <div className="muted small">No local servers yet.</div>}
      {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
      {note && <div className="muted small">{note}</div>}

      {adding ? (
        <div className="card">
          <strong>Add server</strong>
          <label className="field">
            Type
            <select value={type} onChange={(e) => pickType(e.target.value as LocalServerType)}>
              {TYPES.map((t) => <option key={t} value={t}>{SERVER_TYPE_NAMES[t]}</option>)}
            </select>
          </label>
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Address
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://localhost:8080" />
          </label>
          {addError && <div className="small" style={{ color: 'var(--danger)' }}>{addError}</div>}
          <div className="row">
            <button onClick={() => setAdding(false)}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy || !name.trim() || !address.trim()}>Save</button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <button onClick={openAdd}>Add server</button>
          <button onClick={detect} disabled={busy}>Look for local servers</button>
        </div>
      )}
    </div>
  );
}
