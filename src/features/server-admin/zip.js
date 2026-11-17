/**
 * A tiny STORE-only zip writer (no compression), used by /emoji extract and
 * /sticker extract. Images are already compressed (PNG/GIF/WebP), so
 * deflating them would gain almost nothing, and storing keeps this short
 * enough to read in one go. No npm dependency needed.
 *
 *   const buffer = zip([{ name: "smile.png", data: Buffer }]);
 *
 * Layout of a zip file (APPNOTE.TXT):
 *   [local header + file data] x N
 *   [central directory header] x N
 *   [end of central directory record]
 * All integers are little-endian.
 */

// CRC-32 (the IEEE polynomial, reflected) with a 256-entry lookup table.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time/date words, which is what zip stores. */
function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const UTF8_FLAG = 0x0800; // file names are UTF-8

/** Exact size of the zip that zip() would produce for these entries (no data needed). */
const zipSize = (entries) =>
  END_RECORD +
  entries.reduce((sum, e) => sum + LOCAL_HEADER + CENTRAL_HEADER + 2 * Buffer.byteLength(e.name) + (e.size ?? e.data.length), 0);

/**
 * @param {{ name: string, data: Buffer }[]} entries
 * @param {Date} [date] modification time stamped on every entry
 * @returns {Buffer}
 */
function zip(entries, date = new Date()) {
  if (entries.length > 0xffff) throw new Error("zip(): more than 65535 entries needs zip64");
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(LOCAL_HEADER);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(10, 4); // version needed (1.0: stored)
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(CENTRAL_HEADER);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(10, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // 30 extra len, 32 comment len, 34 disk no., 36 internal attrs, 38 external attrs: all 0
    central.writeUInt32LE(offset, 42); // where this file's local header starts
    centrals.push(central, nameBuf);

    offset += LOCAL_HEADER + nameBuf.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(END_RECORD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries total
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Groups entries so that each zip stays at or under `limit` bytes.
 * Entries that can't fit even on their own are returned in `tooLarge`.
 * @returns {{ groups: { name, data }[][], tooLarge: { name, data }[] }}
 */
function splitForLimit(entries, limit) {
  const groups = [];
  const tooLarge = [];
  let current = [];
  for (const entry of entries) {
    if (zipSize([entry]) > limit) {
      tooLarge.push(entry);
      continue;
    }
    if (current.length && zipSize([...current, entry]) > limit) {
      groups.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) groups.push(current);
  return { groups, tooLarge };
}

/** Makes names safe for a zip and unique within it ("smile.png", "smile_2.png"). */
function uniqueNames(entries) {
  const seen = new Map();
  return entries.map((e) => {
    const clean = e.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "file";
    const dot = clean.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    const key = clean.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { ...e, name: n === 1 ? clean : `${base}_${n}${ext}` };
  });
}

module.exports = { zip, zipSize, splitForLimit, uniqueNames, crc32 };
