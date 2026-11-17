/**
 * Pure helpers (no Discord): role-name filtering, a tiny PNG decoder and the
 * "dominant colour" used by /boosterrole dominant.
 *
 * Why a hand-written PNG decoder? The guide asks for no new npm dependencies,
 * and Discord's CDN will serve any avatar as a PNG (`?size=64`), so all we
 * need is zlib (built into Node) plus PNG's row filters. That is ~60 lines.
 */
const zlib = require("zlib");

// ---------------------------------------------------------------- name filter

/**
 * Returns the first blacklisted word contained in `name` (case-insensitive),
 * or null. Words match anywhere in the name, so "bad" also blocks "badge":
 * that is what admins usually expect from a blacklist.
 */
function findBlockedWord(name, words) {
  const text = String(name ?? "").toLowerCase();
  return words.find((w) => w && text.includes(String(w).toLowerCase())) ?? null;
}

/** Trims a requested role name to Discord's 1-100 characters. */
const cleanRoleName = (name) => String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 100);

// ---------------------------------------------------------------- PNG decoding

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Colour type -> channels per pixel (0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA).
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The Paeth predictor from the PNG spec (filter type 4). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes an 8-bit, non-interlaced PNG into { width, height, pixels } where
 * pixels is a flat RGBA Uint8Array. Throws on anything else (16-bit or
 * interlaced images are rare for avatars; the caller reports a friendly error).
 */
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG image");

  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + CRC
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colourType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!header) throw new Error("PNG has no header");
  const { width, height, bitDepth, colourType, interlace } = header;
  const channels = CHANNELS[colourType];
  if (!channels || bitDepth !== 8 || interlace !== 0) throw new Error("unsupported PNG format");
  if (colourType === 3 && !palette) throw new Error("PNG palette missing");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is truncated");

  // Undo the per-row filters. `bpp` = bytes per pixel = the "left" distance.
  const bpp = channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[dst - stride + x - bpp] : 0;
      let predicted;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: predicted = paeth(left, up, upLeft); break;
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[dst + x] = (value + predicted) & 0xff;
    }
  }

  // Expand to RGBA.
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colourType === 6) {
      pixels[d] = out[s]; pixels[d + 1] = out[s + 1]; pixels[d + 2] = out[s + 2]; pixels[d + 3] = out[s + 3];
    } else if (colourType === 2) {
      pixels[d] = out[s]; pixels[d + 1] = out[s + 1]; pixels[d + 2] = out[s + 2]; pixels[d + 3] = 255;
    } else if (colourType === 0 || colourType === 4) {
      pixels[d] = pixels[d + 1] = pixels[d + 2] = out[s];
      pixels[d + 3] = colourType === 4 ? out[s + 1] : 255;
    } else {
      const index = out[s];
      pixels[d] = palette[index * 3]; pixels[d + 1] = palette[index * 3 + 1]; pixels[d + 2] = palette[index * 3 + 2];
      pixels[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }
  return { width, height, pixels };
}

// ---------------------------------------------------------------- dominant colour

/**
 * The most common colour in an RGBA pixel array, ignoring transparent,
 * near-black and near-white pixels (they dominate many avatars but make
 * useless role colours).
 *
 * Method: put each pixel into one of 16x16x16 = 4096 buckets (4 bits per
 * channel), pick the fullest bucket, and return the average of the pixels in
 * it. Averaging inside the bucket gives the "real" shade rather than the
 * bucket's corner. Simpler and deterministic compared with k-means, and good
 * enough for picking one role colour.
 *
 * Returns an integer colour, or null if no pixel qualifies.
 */
function dominantColour(pixels, { minAlpha = 128, dark = 40, light = 215 } = {}) {
  const count = new Uint32Array(4096);
  const sums = new Float64Array(4096 * 3);
  let fallback = null; // average of every opaque pixel, used if all were filtered
  let fr = 0, fg = 0, fb = 0, fn = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    if (a < minAlpha) continue;
    fr += r; fg += g; fb += b; fn++;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < dark || min > light) continue;
    const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    count[bucket]++;
    sums[bucket * 3] += r; sums[bucket * 3 + 1] += g; sums[bucket * 3 + 2] += b;
  }

  let best = -1;
  for (let i = 0; i < 4096; i++) if (count[i] && (best < 0 || count[i] > count[best])) best = i;
  if (best < 0) {
    if (!fn) return null;
    fallback = (Math.round(fr / fn) << 16) | (Math.round(fg / fn) << 8) | Math.round(fb / fn);
    return fallback;
  }
  const n = count[best];
  return (Math.round(sums[best * 3] / n) << 16) | (Math.round(sums[best * 3 + 1] / n) << 8) | Math.round(sums[best * 3 + 2] / n);
}

/** Random colour that is neither near-black nor near-white. */
function randomColour(random = Math.random) {
  for (;;) {
    const c = Math.floor(random() * 0x1000000);
    const r = c >> 16, g = (c >> 8) & 0xff, b = c & 0xff;
    if (Math.max(r, g, b) >= 40 && Math.min(r, g, b) <= 215) return c;
  }
}

module.exports = { findBlockedWord, cleanRoleName, decodePng, dominantColour, randomColour, paeth };
