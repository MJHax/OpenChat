import { useEffect, useState } from 'react';
import type { Memory } from '../../../../shared/types';
import { api } from '../../api';

export function MemoryTab() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [newMemory, setNewMemory] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listMemories().then(setMemories).catch((e: Error) => setError(e.message));
  }, []);

  async function memoryAction(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setMemories(await api.listMemories());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <h2>Memory</h2>
      {error && <p className="error-text">{error}</p>}
      <div className="card">
        <div className="muted small">Enabled memories are added to every chat. Untick a memory to pause it.</div>
        {memories.map((m) => (
          <div key={m.id} className="memory-row">
            <input
              type="checkbox"
              checked={m.enabled}
              onChange={(e) => memoryAction(() => api.updateMemory(m.id, { enabled: e.target.checked }))}
              aria-label="Enabled"
            />
            <input
              type="text"
              defaultValue={m.content}
              onBlur={(e) => {
                const content = e.target.value.trim();
                if (content && content !== m.content) memoryAction(() => api.updateMemory(m.id, { content }));
              }}
            />
            <button className="link danger" onClick={() => memoryAction(() => api.deleteMemory(m.id))}>Delete</button>
          </div>
        ))}
        <form
          className="memory-row"
          onSubmit={(e) => {
            e.preventDefault();
            const content = newMemory.trim();
            if (!content) return;
            memoryAction(() => api.addMemory(content)).then(() => setNewMemory(''));
          }}
        >
          <input type="text" placeholder="Add a memory, e.g. “I prefer metric units”" value={newMemory} onChange={(e) => setNewMemory(e.target.value)} />
          <button type="submit" disabled={!newMemory.trim()}>Add</button>
        </form>
      </div>
    </>
  );
}
