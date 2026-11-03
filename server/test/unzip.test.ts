import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipStream, type ZipEntry } from '../src/zip';
import { extractEntry, readZipIndex, ZipError } from '../src/unzip';

async function zipFile(entries: ZipEntry[], opts: { max32?: number } = {}): Promise<{ dir: string; file: string; bytes: Buffer }> {
  const chunks: Uint8Array[] = [];
  for await (const c of zipStream(entries, opts)) chunks.push(c);
  const bytes = Buffer.concat(chunks);
  const dir = mkdtempSync(join(tmpdir(), 'openchat-unzip-'));
  const file = join(dir, 'test.zip');
  writeFileSync(file, bytes);
  return { dir, file, bytes };
}

const entry = (name: string, data: Buffer): ZipEntry => ({ name, data: () => [data] });

describe('readZipIndex and extractEntry', () => {
  it('round-trips entries written by zipStream', async () => {
    const a = Buffer.from('hello world');
    const b = Buffer.alloc(5000, 7);
    const { dir, file } = await zipFile([entry('one/a.txt', a), entry('two/b.bin', b)]);
    const index = await readZipIndex(file);
    expect([...index.keys()]).toEqual(['one/a.txt', 'two/b.bin']);
    await extractEntry(file, index.get('one/a.txt')!, join(dir, 'a'));
    await extractEntry(file, index.get('two/b.bin')!, join(dir, 'b'));
    expect(readFileSync(join(dir, 'a'))).toEqual(a);
    expect(readFileSync(join(dir, 'b'))).toEqual(b);
  });

  it('follows ZIP64 records', async () => {
    const big = Buffer.alloc(300, 9);
    const { dir, file } = await zipFile([entry('small.txt', Buffer.from('x')), { ...entry('big.bin', big), size: big.length }], { max32: 100 });
    const index = await readZipIndex(file);
    expect(index.get('big.bin')!.size).toBe(300);
    await extractEntry(file, index.get('big.bin')!, join(dir, 'big'));
    expect(readFileSync(join(dir, 'big'))).toEqual(big);
  });

  it('rejects a truncated file', async () => {
    const { dir, bytes } = await zipFile([entry('a.txt', Buffer.from('hello'))]);
    const cut = join(dir, 'cut.zip');
    writeFileSync(cut, bytes.subarray(0, bytes.length - 10));
    await expect(readZipIndex(cut)).rejects.toBeInstanceOf(ZipError);
  });

  it('rejects a bad CRC', async () => {
    const { dir, file, bytes } = await zipFile([entry('a.txt', Buffer.from('hello there'))]);
    const index = await readZipIndex(file);
    const e = index.get('a.txt')!;
    bytes[e.dataOffset] ^= 0xff;
    writeFileSync(file, bytes);
    const dest = join(dir, 'out');
    await expect(extractEntry(file, e, dest)).rejects.toBeInstanceOf(ZipError);
    expect(existsSync(dest)).toBe(false);
  });
});
