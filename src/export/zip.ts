/**
 * Writing a zip, so an export can be a folder rather than one long file.
 *
 * A bible is kept as a folder of files, and an export a writer can actually use
 * — open in an editor, put in a git repo, read in ten years — should have the
 * same shape. One `.md` per scene and per codex entry, not a single document
 * they have to cut up again.
 *
 * Hand-written, and the reader in `src/import/docx.ts` is too. Together they
 * are about 150 lines against a dependency that would be carried into every
 * page load. `CompressionStream` does the actual work, and the browser and Node
 * both have it.
 *
 * This is the same format `readZipEntry` reads, and the docx tests build their
 * fixtures with it — so the reader is proved against this writer rather than
 * against a second implementation that only exists in a test file.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const DEFLATED = 8;
const STORED = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  path: string;
  content: string | Uint8Array;
}

/**
 * MS-DOS date and time, which is what a zip stores.
 *
 * Kept rather than zeroed because an archive whose files all claim 1980 looks
 * broken to every tool that opens it, and a writer checking their backup is
 * real is exactly the person who would notice.
 */
function dosStamp(at: Date): { date: number; time: number } {
  return {
    date: ((Math.max(1980, at.getFullYear()) - 1980) << 9) | ((at.getMonth() + 1) << 5)
      | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  };
}

export async function writeZip(entries: readonly ZipEntry[], at = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const { date, time } = dosStamp(at);
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.content === 'string'
      ? encoder.encode(entry.content)
      : entry.content;
    const compressed = await deflate(raw);
    // Deflate can make a tiny or already-dense file larger. Storing it then is
    // both smaller and faster to read back.
    const deflated = compressed.length < raw.length;
    const body = deflated ? compressed : raw;
    const method = deflated ? DEFLATED : STORED;
    const name = encoder.encode(entry.path);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, 20, true);              // version needed
    lv.setUint16(6, 0x0800, true);          // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER, true);
    cv.setUint16(4, 20, true);              // version made by
    cv.setUint16(6, 20, true);              // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);
    offset += local.length;
  }

  const directorySize = directory.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_DIRECTORY, true);
  ev.setUint16(8, directory.length, true);
  ev.setUint16(10, directory.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...directory, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at2 = 0;
  for (const part of parts) { out.set(part, at2); at2 += part.length; }
  return out;
}
