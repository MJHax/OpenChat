import { describe, it, expect } from 'vitest';
import { zipStream, type ZipEntry } from '../src/zip';
import { readZip } from './zipReader';

async function build(entries: ZipEntry[], max32?: number): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of zipStream(entries, { max32 })) parts.push(chunk);
  return Buffer.concat(parts);
}

const text = (name: string, ...chunks: string[]): ZipEntry => ({ name, data: () => chunks.map((c) => Buffer.from(c)) });

describe('zipStream', () => {
  it('writes entries a zip reader can read back, chunk by chunk', async () => {
    const zip = await build([text('a.txt', 'hello ', 'world'), text('folder/ünïcode ✓.md', '# hi'), text('empty.txt')]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['a.txt', 'folder/ünïcode ✓.md', 'empty.txt']);
    expect(files.get('a.txt')!.toString()).toBe('hello world');
    expect(files.get('folder/ünïcode ✓.md')!.toString()).toBe('# hi');
    expect(files.get('empty.txt')!.length).toBe(0);
  });

  it('streams async sources', async () => {
    async function* gen() { yield Buffer.from('one'); yield Buffer.from('two'); }
    const files = readZip(await build([{ name: 'x.bin', data: gen }]));
    expect(files.get('x.bin')!.toString()).toBe('onetwo');
  });

  it('switches to ZIP64 records when sizes or offsets pass the 32-bit limit', async () => {
    const big = 'x'.repeat(300);
    const zip = await build([text('a', 'y'.repeat(150)), { ...text('b', big), size: 300 }, text('c', 'small')], 200);
    const files = readZip(zip);
    expect(files.get('a')!.toString()).toBe('y'.repeat(150));
    expect(files.get('b')!.toString()).toBe(big);
    expect(files.get('c')!.toString()).toBe('small');
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
  });

  it('refuses a file that turns out too big without its size given up front', async () => {
    await expect(build([text('a', 'x'.repeat(300))], 200)).rejects.toThrow(/4 GB/);
  });
});
