import { crc32 } from 'node:zlib';

/** One file in the archive. `data` is read once, when the writer reaches the entry. */
export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  data: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  /** Byte size, when known up front; only needed for a file of 4 GB or more. */
  size?: number;
}

const MAX32 = 0xffffffff;
const FLAGS = 0x0808; // sizes and CRC follow the data (bit 3); names are UTF-8 (bit 11)

interface Written { name: Buffer; crc: number; size: number; offset: number; zip64: boolean; time: number; date: number }

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/**
 * Streams a store-only (uncompressed) zip: each entry's bytes are passed through as they are read, so nothing is held
 * in memory but the central directory. ZIP64 records are added only where a size, offset or count needs them.
 * `max32` is the largest value a 32-bit field may hold; tests lower it to exercise the ZIP64 path.
 */
export async function* zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, opts: { now?: Date; max32?: number } = {}): AsyncGenerator<Uint8Array> {
  const limit = opts.max32 ?? MAX32;
  const { time, date } = dosDateTime(opts.now ?? new Date());
  const written: Written[] = [];
  let offset = 0;
  const emit = (b: Buffer) => {
    offset += b.length;
    return b;
  };

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const zip64 = entry.size !== undefined && entry.size >= limit;
    const start = offset;
    const extra = zip64 ? Buffer.concat([Buffer.from([1, 0, 16, 0]), u64(0), u64(0)]) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // CRC and sizes stay 0 here (ZIP64: all ones); the data descriptor after the data has them.
    if (zip64) { header.writeUInt32LE(MAX32, 18); header.writeUInt32LE(MAX32, 22); }
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    yield emit(Buffer.concat([header, name, extra]));

    let crc = 0;
    let size = 0;
    for await (const chunk of entry.data()) {
      if (chunk.length === 0) continue;
      crc = crc32(chunk, crc);
      size += chunk.length;
      offset += chunk.length;
      yield chunk;
    }
    if (!zip64 && size >= limit) throw new Error(`${entry.name} is 4 GB or larger; give its size up front.`);

    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    if (zip64) { descriptor.writeBigUInt64LE(BigInt(size), 8); descriptor.writeBigUInt64LE(BigInt(size), 16); }
    else { descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); }
    yield emit(descriptor);
    written.push({ name, crc: crc >>> 0, size, offset: start, zip64, time, date });
  }

  const cdStart = offset;
  for (const w of written) {
    const bigSize = w.zip64 || w.size >= limit;
    const bigOffset = w.offset >= limit;
    const fields = [...(bigSize ? [u64(w.size), u64(w.size)] : []), ...(bigOffset ? [u64(w.offset)] : [])];
    const extraBody = Buffer.concat(fields);
    const extra = fields.length ? Buffer.concat([Buffer.from([1, 0, extraBody.length, 0]), extraBody]) : Buffer.alloc(0);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(45, 4);
    h.writeUInt16LE(fields.length ? 45 : 20, 6);
    h.writeUInt16LE(FLAGS, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(w.time, 12);
    h.writeUInt16LE(w.date, 14);
    h.writeUInt32LE(w.crc, 16);
    h.writeUInt32LE(bigSize ? MAX32 : w.size, 20);
    h.writeUInt32LE(bigSize ? MAX32 : w.size, 24);
    h.writeUInt16LE(w.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt32LE(bigOffset ? MAX32 : w.offset, 42);
    yield emit(Buffer.concat([h, w.name, extra]));
  }
  const cdSize = offset - cdStart;

  const needs64 = written.length >= 0xffff || cdStart >= limit || cdSize >= limit;
  if (needs64) {
    const at = offset;
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(written.length), 24);
    rec.writeBigUInt64LE(BigInt(written.length), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(at), 8);
    locator.writeUInt32LE(1, 16);
    yield emit(Buffer.concat([rec, locator]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needs64 ? 0xffff : written.length, 8);
  end.writeUInt16LE(needs64 ? 0xffff : written.length, 10);
  end.writeUInt32LE(needs64 ? MAX32 : cdSize, 12);
  end.writeUInt32LE(needs64 ? MAX32 : cdStart, 16);
  yield emit(end);
}

/** A web stream over an async generator, pulling one chunk at a time so a slow download never piles data up in memory. */
export function toWebStream(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}
