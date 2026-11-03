import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

/** Where one stored file's bytes sit inside the archive. */
export interface ZipFileEntry { name: string; dataOffset: number; size: number; crc: number }

/** The archive is malformed, truncated or damaged. */
export class ZipError extends Error {}

const MAX32 = 0xffffffff;

async function read(fh: FileHandle, at: number, length: number, fileSize: number): Promise<Buffer> {
  if (at < 0 || length < 0 || at + length > fileSize) throw new ZipError('The zip file is truncated.');
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, at);
  if (bytesRead !== length) throw new ZipError('The zip file is truncated.');
  return buf;
}

/**
 * Reads the central directory of a store-only zip (as zipStream writes) from disk, without loading the entries.
 * Every offset and size is checked against the file's length, so a truncated upload is caught here.
 */
export async function readZipIndex(file: string): Promise<Map<string, ZipFileEntry>> {
  const fh = await open(file, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    // The end record is the last 22 bytes plus an optional comment of up to 64 KB.
    const tailLen = Math.min(fileSize, 22 + 0xffff);
    const tail = await read(fh, fileSize - tailLen, tailLen, fileSize);
    let endAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { endAt = i; break; }
    }
    if (endAt < 0) throw new ZipError('This is not a zip file, or it is truncated.');
    let count = tail.readUInt16LE(endAt + 10);
    let cdSize = tail.readUInt32LE(endAt + 12);
    let cdOffset = tail.readUInt32LE(endAt + 16);
    if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
      const locator = await read(fh, fileSize - tailLen + endAt - 20, 20, fileSize);
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new ZipError('The zip file is damaged.');
      const rec = await read(fh, Number(locator.readBigUInt64LE(8)), 56, fileSize);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new ZipError('The zip file is damaged.');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = await read(fh, cdOffset, cdSize, fileSize);
    const out = new Map<string, ZipFileEntry>();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip file is damaged.');
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError('The zip file is damaged.');
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      if (extra.length >= 4 && extra.readUInt16LE(0) === 1) {
        let q = 4;
        // zipStream writes both sizes when either is too big; store-only, so they are equal.
        if (size === MAX32) { size = Number(extra.readBigUInt64LE(q)); q += 16; }
        if (offset === MAX32) offset = Number(extra.readBigUInt64LE(q));
      }
      if (method !== 0) throw new ZipError(`${name} is compressed; only OpenChat's own zips can be read.`);
      const local = await read(fh, offset, 30, fileSize);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError('The zip file is damaged.');
      const dataOffset = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (dataOffset + size > fileSize) throw new ZipError('The zip file is truncated.');
      out.set(name, { name, dataOffset, size, crc });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Streams one entry to `dest`, checking its CRC; a damaged entry leaves no file behind. */
export async function extractEntry(file: string, entry: ZipFileEntry, dest: string): Promise<void> {
  let crc = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, done) {
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
  });
  const source = entry.size === 0 ? [] : createReadStream(file, { start: entry.dataOffset, end: entry.dataOffset + entry.size - 1 });
  try {
    await pipeline(source, check, createWriteStream(dest));
    if (crc >>> 0 !== entry.crc) throw new ZipError(`${entry.name} is damaged.`);
  } catch (err) {
    rmSync(dest, { force: true });
    throw err instanceof ZipError ? err : new ZipError(`${entry.name} couldn't be read: ${(err as Error).message}`);
  }
}
