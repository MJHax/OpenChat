import { describe, it, expect } from 'vitest';
import { cardOpenable, panelView } from './filePanelState';
import type { FileVersion } from '../../../shared/files';

const v = (messageId: string, version: number): FileVersion => ({ name: 'p.html', messageId, version, file: { name: 'p.html', content: `v${version}`, complete: true } });

describe('panelView', () => {
  it('shows the version from the reply that was opened', () => {
    expect(panelView({ name: 'p.html', messageId: 'b', adhoc: null }, [v('a', 1), v('b', 2)])).toEqual({ versions: [v('a', 1), v('b', 2)], initial: 2 });
  });

  it('closes when that reply is no longer on the path', () => {
    // e.g. the reply was regenerated into one without the file, or a sibling was picked
    expect(panelView({ name: 'p.html', messageId: 'gone', adhoc: null }, [])).toBeNull();
    expect(panelView({ name: 'p.html', messageId: 'gone', adhoc: null }, [v('a', 1)])).toBeNull();
  });

  it('always shows a snippet', () => {
    const adhoc = { name: 'snippet.py', content: 'x', complete: true };
    expect(panelView({ name: 'snippet.py', messageId: null, adhoc }, [])).toEqual({ versions: [], initial: 1 });
  });
});

describe('cardOpenable', () => {
  it('waits until a streaming file is finished', () => {
    expect(cardOpenable({ name: 'a', content: '', complete: false }, true)).toBe(false);
    expect(cardOpenable({ name: 'a', content: '', complete: true }, true)).toBe(true);
    expect(cardOpenable({ name: 'a', content: '', complete: false }, false)).toBe(true);
  });
});
