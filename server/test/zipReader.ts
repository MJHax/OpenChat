import { crc32 } from 'node:zlib';

/** A minimal store-only zip reader for tests: follows the central directory (and ZIP64 records) and checks every CRC. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  let end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50) throw new Error('no end record');
  let count = zip.readUInt16LE(end + 10);
  let cdOffset = zip.readUInt32LE(end + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locator = end - 20;
    if (zip.readUInt32LE(locator) !== 0x07064b50) throw new Error('no zip64 locator');
    end = Number(zip.readBigUInt64LE(locator + 8));
    if (zip.readUInt32LE(end) !== 0x06064b50) throw new Error('no zip64 end record');
    count = Number(zip.readBigUInt64LE(end + 32));
    cdOffset = Number(zip.readBigUInt64LE(end + 48));
  }
  const out = new Map<string, Buffer>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const crc = zip.readUInt32LE(p + 16);
    let size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    let offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = zip.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (extra.length && extra.readUInt16LE(0) === 1) {
      let q = 4;
      if (size === 0xffffffff) { size = Number(extra.readBigUInt64LE(q)); q += 16; }
      if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(q));
    }
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataAt = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    if (crc32(data) >>> 0 !== crc) throw new Error(`bad CRC for ${name}`);
    out.set(name, Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
