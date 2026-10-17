import { describe, it, expect } from 'vitest';
import { collapseSuperseded, copyText, fileKind, fileVersions, mapFileBlocks, mimeFor, parseFileBlocks, safeFileName } from './files';

const fileAt = (text: string, i: number) => {
  const seg = parseFileBlocks(text)[i];
  if (seg?.type !== 'file') throw new Error(`segment ${i} is not a file`);
  return seg.file;
};

describe('parseFileBlocks', () => {
  it('returns one text segment for plain text', () => {
    expect(parseFileBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('splits text, a file, and trailing text', () => {
    expect(parseFileBlocks('Here:\n<file name="a.html">\n<p>x</p>\n</file>\nDone')).toEqual([
      { type: 'text', text: 'Here:\n' },
      { type: 'file', file: { name: 'a.html', content: '<p>x</p>', complete: true } },
      { type: 'text', text: '\nDone' },
    ]);
  });

  it('parses several files in order', () => {
    const segs = parseFileBlocks('<file name="a.css">\nb{}\n</file>\nand\n<file name="b.js">\nx()\n</file>');
    expect(segs.filter((s) => s.type === 'file').map((s) => (s.type === 'file' ? s.file.name : ''))).toEqual(['a.css', 'b.js']);
  });

  it('keeps blank lines and indentation inside a file', () => {
    expect(fileAt('<file name="a.py">\ndef f():\n\n    return 1\n</file>', 0).content).toBe('def f():\n\n    return 1');
  });

  it('strips one code fence wrapped around a whole block', () => {
    const segs = parseFileBlocks('Sure:\n```html\n<file name="a.html">\n<p/>\n</file>\n```\nok');
    expect(segs).toEqual([
      { type: 'text', text: 'Sure:\n' },
      { type: 'file', file: { name: 'a.html', content: '<p/>', complete: true } },
      { type: 'text', text: '\nok' },
    ]);
  });

  it('marks an unclosed block at the end as incomplete', () => {
    expect(parseFileBlocks('<file name="a.md">\n# T\nmore').at(-1)).toEqual({
      type: 'file', file: { name: 'a.md', content: '# T\nmore', complete: false },
    });
  });

  it('ignores a tag that does not start a line', () => {
    expect(parseFileBlocks('use <file name="a.txt"> tags')).toEqual([{ type: 'text', text: 'use <file name="a.txt"> tags' }]);
  });

  it('closes only on a line that is exactly </file>', () => {
    const f = fileAt('<file name="a.html">\n<code>x </file> y</code>\n  </file>  \nafter', 0);
    expect(f).toEqual({ name: 'a.html', content: '<code>x </file> y</code>', complete: true });
  });

  it('decodes &quot; and &amp; in the name', () => {
    expect(fileAt('<file name="a &quot;b&quot; &amp; c.txt">\nx\n</file>', 0).name).toBe('a "b" & c.txt');
  });

  it('handles CRLF line endings', () => {
    expect(fileAt('<file name="a.txt">\r\nx\r\n</file>\r\n', 0)).toEqual({ name: 'a.txt', content: 'x', complete: true });
  });

  it('gives an empty file for a block with nothing inside', () => {
    expect(fileAt('<file name="a.txt">\n</file>', 0)).toEqual({ name: 'a.txt', content: '', complete: true });
  });
});

describe('mapFileBlocks', () => {
  it('replaces blocks and keeps text', () => {
    expect(mapFileBlocks('A\n<file name="x.txt">\n1\n</file>\nB', (f) => `[file: ${f.name}]`)).toBe('A\n[file: x.txt]\nB');
  });

  it('replaces an unclosed block too', () => {
    expect(mapFileBlocks('A\n<file name="x.txt">\n1', (f) => `[${f.name}]`)).toBe('A\n[x.txt]');
  });
});

describe('fileKind', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(fileKind('A.HTML')).toBe('html');
    expect(fileKind('b.htm')).toBe('html');
    expect(fileKind('x.svg')).toBe('svg');
    expect(fileKind('n.md')).toBe('md');
    expect(fileKind('d.csv')).toBe('csv');
    expect(fileKind('s.py')).toBe('code');
    expect(fileKind('notes.txt')).toBe('code');
    expect(fileKind('blob.bin')).toBe('other');
    expect(fileKind('README')).toBe('other');
  });
});

describe('mimeFor', () => {
  it('maps common types', () => {
    expect(mimeFor('a.html')).toBe('text/html;charset=utf-8');
    expect(mimeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeFor('a.csv')).toBe('text/csv;charset=utf-8');
    expect(mimeFor('a.json')).toBe('application/json;charset=utf-8');
    expect(mimeFor('a.md')).toBe('text/markdown;charset=utf-8');
    expect(mimeFor('a.py')).toBe('text/plain;charset=utf-8');
  });
});

describe('safeFileName', () => {
  it('keeps only a safe base name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a/b.html')).toBe('b.html');
    expect(safeFileName('a\\b:c*?.txt')).toBe('b_c__.txt');
    expect(safeFileName('   ')).toBe('file.txt');
    expect(safeFileName('report.html')).toBe('report.html');
  });
});

const a = (id: string, content: string) => ({ id, role: 'assistant' as const, content });
const u = (id: string, content: string) => ({ id, role: 'user' as const, content });
const f = (name: string, body: string) => `<file name="${name}">\n${body}\n</file>`;

describe('fileVersions', () => {
  it('numbers same-name files across the path', () => {
    const v = fileVersions([u('1', 'make'), a('2', f('p.html', 'v1')), u('3', 'blue'), a('4', f('p.html', 'v2'))]);
    expect(v.get('p.html')!.map((x) => [x.messageId, x.version, x.file.content])).toEqual([['2', 1, 'v1'], ['4', 2, 'v2']]);
  });

  it('keeps different names apart', () => {
    const v = fileVersions([a('2', `${f('a.css', '1')}\n${f('b.js', '2')}`)]);
    expect([...v.keys()]).toEqual(['a.css', 'b.js']);
    expect(v.get('b.js')![0].version).toBe(1);
  });

  it('skips user messages', () => {
    expect(fileVersions([u('1', f('p.html', 'x'))]).size).toBe(0);
  });

  it('ignores other branches', () => {
    // The caller passes only the active path; a stopped sibling holding p.html is simply not in it.
    const path = [u('1', 'make'), a('3', f('p.html', 'regenerated'))];
    expect(fileVersions(path).get('p.html')!.map((x) => [x.messageId, x.version])).toEqual([['3', 1]]);
  });
});

describe('copyText', () => {
  it('replaces blocks with markers', () => {
    expect(copyText(`Hi\n${f('a.csv', '1,2')}`)).toBe('Hi\n[file: a.csv]');
  });
});

describe('collapseSuperseded', () => {
  it('keeps only the latest version in full', () => {
    const out = collapseSuperseded([u('1', 'x'), a('2', f('p.html', 'old')), a('4', `${f('p.html', 'new')}\n${f('q.md', 'q')}`)]);
    expect(out[1]).toBe('<file name="p.html" superseded="true" />');
    expect(out[2]).toBe(`${f('p.html', 'new')}\n${f('q.md', 'q')}`);
  });

  it('leaves user messages untouched', () => {
    const out = collapseSuperseded([u('1', f('p.html', 'pasted')), a('2', f('p.html', 'made'))]);
    expect(out[0]).toBe(f('p.html', 'pasted'));
  });

  it('escapes quotes in the name', () => {
    const block = (n: string) => `<file name="a &quot;b&quot;.txt">\n${n}\n</file>`;
    expect(collapseSuperseded([a('1', block('1')), a('2', block('2'))])[0]).toBe('<file name="a &quot;b&quot;.txt" superseded="true" />');
  });
});
