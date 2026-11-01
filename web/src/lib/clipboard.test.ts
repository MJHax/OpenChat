import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeClipboard } from './clipboard';

/** The parts of a page the fallback touches: `copied` is what the browser's copy command would have taken. */
function fakePage({ copyWorks = true } = {}) {
  const page = {
    copied: null as string | null,
    attached: [] as unknown[],
    focusReturned: false,
    selected: null as { value: string } | null,
  };
  const button = { focus: () => { page.focusReturned = true; } };
  vi.stubGlobal('document', {
    activeElement: button,
    body: { append: (el: unknown) => page.attached.push(el) },
    createElement: () => {
      const field = {
        value: '',
        style: {},
        setAttribute() {},
        select() { page.selected = field; },
        remove() { page.attached = page.attached.filter((el) => el !== field); },
      };
      return field;
    },
    execCommand(command: string) {
      if (command !== 'copy' || !copyWorks || !page.selected || !page.attached.includes(page.selected)) return false;
      page.copied = page.selected.value;
      return true;
    },
  });
  return page;
}

afterEach(() => vi.unstubAllGlobals());

describe('writeClipboard', () => {
  it('uses the Clipboard API where the browser offers it', async () => {
    const page = fakePage();
    const written: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { written.push(text); } } });
    await writeClipboard('hello');
    expect(written).toEqual(['hello']);
    expect(page.copied).toBeNull();
  });

  it('copies through a temporary field on a plain http address, where the API is missing', async () => {
    const page = fakePage();
    vi.stubGlobal('navigator', {});
    await writeClipboard('line one\nline two');
    expect(page.copied).toBe('line one\nline two');
    expect(page.attached).toEqual([]);
    expect(page.focusReturned).toBe(true);
  });

  it('rejects and leaves nothing behind when the browser refuses the copy', async () => {
    const page = fakePage({ copyWorks: false });
    vi.stubGlobal('navigator', {});
    await expect(writeClipboard('hello')).rejects.toThrow();
    expect(page.attached).toEqual([]);
  });
});
