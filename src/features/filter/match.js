/**
 * Pure matching logic for the chat filters. No Discord objects, no database:
 * everything here takes plain strings / numbers so it can be unit-tested
 * offline (filter.test.js).
 *
 * compileGuild() turns the database rows for one guild into the structure the
 * message listener reads on every message (pre-built regexes, Sets, Maps).
 */
const {
  THRESHOLDS, MIN_CAPS_LETTERS, SPAM_WINDOW_MS, LIMITS, TYPES,
} = require("./constants");

// ------------------------------------------------------------------ text helpers

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
// Combining diacritical marks (the blocks zalgo text is built from).
const COMBINING_CLASS = "\\u0300-\\u036F\\u1AB0-\\u1AFF\\u1DC0-\\u1DFF\\u20D0-\\u20FF\\uFE20-\\uFE2F";
const COMBINING_G = new RegExp(`[${COMBINING_CLASS}]`, "g");
const IS_COMBINING = new RegExp(`[${COMBINING_CLASS}]`);
// A "word character" for the word filter: any letter or digit in any script.
const WORD_CHAR = "[\\p{L}\\p{N}_]";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text as the word filter sees it: compatibility-decomposed (fullwidth and
 * styled letters become plain ones), accents and zero-width characters
 * removed, lower case. "Ｂàd" -> "bad".
 */
const normalise = (text) => String(text).normalize("NFKD").replace(COMBINING_G, "").replace(ZERO_WIDTH, "").toLowerCase();

// ------------------------------------------------------------------ words

/**
 * Regex source for one filter word. Wildcards work like Discord AutoMod:
 *   "bad"    whole word only      ("bad" yes, "badge" no)
 *   "bad*"   words starting with  ("badge" yes)
 *   "*bad"   words ending with    ("notbad" yes)
 *   "*bad*"  anywhere in a word   ("forbade" yes)
 * A match always expands to the whole word(s) it sits in, so the allow list
 * can compare complete words ("*ass*" blocked, "class" allowed).
 * Spaces in a phrase match any run of whitespace.
 */
function wordSource(entry) {
  let w = normalise(entry).trim();
  const starStart = w.startsWith("*");
  const starEnd = w.endsWith("*");
  w = w.replace(/^\*+|\*+$/g, "");
  if (!w) return null;
  const body = escapeRegex(w).replace(/\s+/g, "\\s+");
  return `(?<!${WORD_CHAR})${starStart ? `${WORD_CHAR}*` : ""}${body}${starEnd ? `${WORD_CHAR}*` : ""}(?!${WORD_CHAR})`;
}

/*
 * User regexes run on every message, so a pattern like "(a|a)*b" could freeze
 * the whole bot (catastrophic backtracking). They are therefore compiled with
 * V8's linear-time engine (the "l" flag): matching time grows linearly with
 * the message, whatever the pattern. That engine has no "i" or "u" flag and no
 * lookarounds/backreferences (Discord AutoMod's regex doesn't either), so:
 *   - the pattern is lowercased outside escape sequences, and
 *   - it is matched against the lowercased message text.
 */
require("v8").setFlagsFromString("--enable-experimental-regexp-engine");

/** Lowercases a pattern, leaving escapes (\S, \W, \B, \x41...) alone. */
function linearSource(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      out += pattern[i] + (pattern[i + 1] ?? "");
      i++;
    } else out += pattern[i].toLowerCase();
  }
  return out;
}

/** Compiles a user pattern for the linear engine (throws when it can't run linearly). */
const compileUserRegex = (pattern) => new RegExp(linearSource(pattern), "gl");

/**
 * Rejects regex patterns that are invalid, too long, or can't run in linear
 * time. Returns an error string or null.
 */
function regexProblem(pattern) {
  if (!pattern || pattern.length > LIMITS.regexLength) return `Patterns must be 1-${LIMITS.regexLength} characters.`;
  try {
    compileUserRegex(pattern);
  } catch (err) {
    if (/linear time/.test(err.message))
      return "Lookarounds like `(?=...)` and backreferences like `\\1` aren't supported (they can freeze the bot). Rewrite the pattern without them.";
    return `That isn't a valid regex: ${err.message.replace(/^Invalid regular expression: /, "")}`;
  }
  return null;
}

/**
 * Builds the word matcher from the stored word rows.
 * @param {{ word: string, kind: "block"|"allow"|"regex" }[]} rows
 */
function compileWords(rows) {
  const block = [];
  const allow = [];
  const regex = [];
  for (const r of rows) (r.kind === "allow" ? allow : r.kind === "regex" ? regex : block).push(r.word);
  const sources = block.map(wordSource).filter(Boolean);
  const regexes = [];
  for (const pattern of regex) {
    if (regexProblem(pattern)) continue; // validated on add; skip anything that slipped in (or now fails)
    regexes.push(compileUserRegex(pattern));
  }
  return {
    block: sources.length ? new RegExp(sources.join("|"), "gu") : null,
    allow: new Set(allow.map((w) => normalise(w).trim())),
    regexes,
    lists: { block, allow, regex },
  };
}

/**
 * First blocked word/pattern in `text` that isn't allow-listed, or null.
 * Returns { rule: "word"|"regex", match } where match is the offending text.
 */
function matchWords(words, text) {
  if (!text || (!words.block && !words.regexes.length)) return null;
  if (words.block) {
    const norm = normalise(text);
    for (const m of norm.matchAll(words.block)) {
      if (!words.allow.has(m[0].replace(/\s+/g, " "))) return { rule: "word", match: m[0] };
    }
  }
  // User regexes are lowercased and run on lowercased text (see linearSource).
  const lower = words.regexes.length ? text.toLowerCase() : "";
  for (const re of words.regexes) {
    for (const m of lower.matchAll(re)) {
      if (m[0] && !words.allow.has(normalise(m[0]).trim())) return { rule: "regex", match: m[0] };
    }
  }
  return null;
}

// ------------------------------------------------------------------ invites / links

const INVITE = /(?:discord(?:app)?\.com\/invite|discord\.(?:gg|io|me|li)|dsc\.gg)\/[a-z0-9-]+/i;
const URL_G = /\bhttps?:\/\/(?:[^\s/?#@<>]*@)?([^\s/?#:<>()[\]|]+)/gi;

const findInvite = (text) => text.match(INVITE)?.[0] ?? null;

/** "WWW.Example.com." -> "example.com" */
const normaliseHost = (host) => String(host).toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

/** Every http(s) host linked in `text`, normalised. */
function linkHosts(text) {
  const hosts = [];
  for (const m of String(text).matchAll(URL_G)) hosts.push(normaliseHost(m[1]));
  return hosts;
}

/** True when `host` or any parent domain is whitelisted (subdomains match). */
function hostAllowed(host, allowed) {
  let h = host;
  for (;;) {
    if (allowed.has(h)) return true;
    const dot = h.indexOf(".");
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}

/** First linked host that isn't whitelisted, or null. */
function findBadLink(text, allowed) {
  for (const host of linkHosts(text)) if (!hostAllowed(host, allowed)) return host;
  return null;
}

/**
 * Turns what the user typed for /filter url into a host, or null.
 * Accepts "example.com", "https://www.example.com/path", "*.example.com".
 */
function parseHost(input) {
  const raw = String(input).trim().replace(/^\*\./, "");
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = normaliseHost(url.hostname);
    return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(host) || /^xn--/.test(host) ? host : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ counters

const CUSTOM_EMOJI_G = /<a?:\w{1,32}:\d{15,25}>/g;
const MENTION_NOISE_G = /<(?:@[!&]?|#)\d{15,25}>/g;
const URL_NOISE_G = /https?:\/\/\S+/gi;
const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Percentage (0-100) of letters that are capitals; 0 for short messages. */
function capsPercent(text) {
  const clean = String(text).replace(URL_NOISE_G, "").replace(CUSTOM_EMOJI_G, "").replace(MENTION_NOISE_G, "");
  let letters = 0;
  let upper = 0;
  for (const ch of clean) {
    const lower = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lower === up) continue; // not a cased letter
    letters++;
    if (ch === up) upper++;
  }
  return letters < MIN_CAPS_LETTERS ? 0 : Math.round((upper * 100) / letters);
}

/** Custom emojis plus unicode emoji graphemes (a flag or ZWJ family counts once). */
function countEmojis(text) {
  const str = String(text);
  let n = (str.match(CUSTOM_EMOJI_G) ?? []).length;
  const rest = n ? str.replace(CUSTOM_EMOJI_G, "") : str;
  if (!PICTO.test(rest)) return n;
  for (const { segment } of segmenter.segment(rest)) if (PICTO.test(segment)) n++;
  return n;
}

/** Distinct user and role mentions. */
function countMentions(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/<@([!&]?)(\d{15,25})>/g)) ids.add(`${m[1] === "&" ? "r" : "u"}${m[2]}`);
  return ids.size;
}

const hasMassMention = (text) => /@(?:everyone|here)\b/.test(String(text));

const countNewlines = (text) => (String(text).match(/\n/g) ?? []).length;

/** Longest run of combining marks on one character (zalgo stacks dozens). */
function maxCombiningRun(text) {
  let best = 0;
  let run = 0;
  for (const ch of String(text)) {
    if (IS_COMBINING.test(ch)) {
      run++;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

const stripZalgo = (text) => String(text).replace(COMBINING_G, "");

// ------------------------------------------------------------------ spam

/**
 * Per-user sliding windows kept in memory. hit() records a message and, when
 * the user has sent `threshold` or more within the window, returns the
 * recorded entries (so the caller can delete them) and starts a new window.
 */
class SpamTracker {
  constructor(windowMs = SPAM_WINDOW_MS) {
    this.windowMs = windowMs;
    this.windows = new Map(); // key -> [{ t, channelId, messageId }]
  }

  hit(key, entry, threshold, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = (this.windows.get(key) ?? []).filter((e) => e.t > cutoff);
    list.push({ ...entry, t: now });
    if (list.length >= threshold) {
      this.windows.delete(key);
      return list;
    }
    this.windows.set(key, list);
    return null;
  }

  /** Drops expired windows so idle users don't stay in memory. */
  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.windows) if (!list.some((e) => e.t > cutoff)) this.windows.delete(key);
  }
}

// ------------------------------------------------------------------ compile + detect

/** Base values every filter starts from before the guild's settings apply. */
const defaultsFor = (type) => ({ enabled: false, threshold: THRESHOLDS[type]?.default ?? null, punishment: "delete", durationMs: null });

const rowToSetting = (r) => ({
  enabled: r.enabled === null || r.enabled === undefined ? null : Boolean(r.enabled),
  threshold: r.threshold ?? null,
  punishment: r.punishment ?? null,
  durationMs: r.duration_ms ?? null,
});

/** Copies the non-null fields of `override` over `base`. */
const merge = (base, override) => {
  const out = { ...base };
  if (override) for (const [k, v] of Object.entries(override)) if (v !== null && v !== undefined) out[k] = v;
  return out;
};

/**
 * One guild's rows -> the hot-path structure.
 * @param {{ settings, exempt, words, urls, points, ladder, limit, snipe }} data plain DB rows
 */
function compileGuild({ settings = [], exempt = [], words = [], urls = [], points = [], ladder = [], limit = null, snipe = [] } = {}) {
  const types = new Map(); // type -> { base, channels: Map(channelId -> setting) }
  for (const r of settings) {
    if (!types.has(r.type)) types.set(r.type, { base: null, channels: new Map() });
    const t = types.get(r.type);
    if (r.channel_id) t.channels.set(r.channel_id, rowToSetting(r));
    else t.base = rowToSetting(r);
  }

  // Is any message filter switched on anywhere? Lets the listener bail out at once.
  let active = false;
  let namesActive = false;
  for (const [type, t] of types) {
    const on = t.base?.enabled || [...t.channels.values()].some((s) => s.enabled);
    if (!on) continue;
    if (type === "names") namesActive = true;
    else active = true;
  }

  const exemptMap = new Map();
  for (const r of exempt) {
    if (!exemptMap.has(r.type)) exemptMap.set(r.type, new Set());
    exemptMap.get(r.type).add(r.role_id);
  }

  return {
    active,
    namesActive,
    types,
    exempt: exemptMap,
    words: compileWords(words),
    urls: new Set(urls.map((r) => r.host)),
    points: new Map(points.map((r) => [r.type, r.points])),
    ladder: [...ladder].map((r) => ({ points: r.points, punishment: r.punishment, durationMs: r.duration_ms ?? null })).sort((a, b) => a.points - b.points),
    limit: limit || null,
    snipe: new Set(snipe.filter((r) => r.enabled).map((r) => r.type)),
  };
}

/**
 * The effective setting of `type` in a channel: defaults <- server default <-
 * channel override (a thread falls back to its parent's override).
 * Returns null when the filter is off there.
 */
function settingFor(compiled, type, channelIds = []) {
  const t = compiled.types.get(type);
  if (!t) return null;
  let s = merge(defaultsFor(type), t.base);
  const override = channelIds.map((id) => t.channels.get(id)).find(Boolean);
  s = merge(s, override);
  return s.enabled ? s : null;
}

/** Same as settingFor but returns the setting even when disabled (for /filter config). */
function describeSetting(compiled, type, channelId) {
  const t = compiled.types.get(type);
  return merge(merge(defaultsFor(type), t?.base), channelId ? t?.channels.get(channelId) : null);
}

/** True when the member has a role exempt from `type`. */
function roleExempt(compiled, type, roleIds) {
  const set = compiled.exempt.get(type);
  if (!set?.size) return false;
  for (const id of roleIds) if (set.has(id)) return true;
  return false;
}

/**
 * Runs one filter against a message-like input. Returns
 * { detail, match?, entries? } on a hit, else null. `detail` is safe to show
 * publicly; `match` may contain the offending text (log it spoilered, staff only).
 *
 * @param {string} type
 * @param {{ content: string, attachments?: number, stickers?: number, userKey?: string, channelId?: string, messageId?: string, now?: number }} input
 * @param {number|null} threshold
 * @param {ReturnType<typeof compileGuild>} compiled
 * @param {SpamTracker} [spam]
 */
function detect(type, input, threshold, compiled, spam) {
  const text = input.content ?? "";
  switch (type) {
    case "words": {
      const hit = matchWords(compiled.words, text);
      return hit ? { detail: hit.rule === "regex" ? "blocked pattern" : "blocked word", match: hit.match } : null;
    }
    case "invites": {
      const inv = findInvite(text);
      return inv ? { detail: "server invite", match: inv } : null;
    }
    case "links": {
      const host = findBadLink(text, compiled.urls);
      return host ? { detail: `link to ${host}`, match: host } : null;
    }
    case "massmention":
      return hasMassMention(text) ? { detail: "@everyone/@here" } : null;
    case "mentions": {
      const n = countMentions(text);
      return n >= threshold ? { detail: `${n} mentions` } : null;
    }
    case "caps": {
      const pct = capsPercent(text);
      return pct >= threshold ? { detail: `${pct}% caps` } : null;
    }
    case "emojis": {
      const n = countEmojis(text);
      return n >= threshold ? { detail: `${n} emojis` } : null;
    }
    case "newlines": {
      const n = countNewlines(text);
      return n >= threshold ? { detail: `${n} line breaks` } : null;
    }
    case "zalgo": {
      const n = maxCombiningRun(text);
      return n >= threshold ? { detail: "zalgo text" } : null;
    }
    case "attachments": {
      const n = input.attachments ?? 0;
      return n && n >= threshold ? { detail: `${n} attachment${n === 1 ? "" : "s"}` } : null;
    }
    case "stickers": {
      const n = input.stickers ?? 0;
      return n && n >= threshold ? { detail: "sticker" } : null;
    }
    case "spam": {
      if (!spam || !input.userKey) return null;
      const entries = spam.hit(input.userKey, { channelId: input.channelId, messageId: input.messageId }, threshold, input.now);
      return entries ? { detail: `${entries.length} messages in ${SPAM_WINDOW_MS / 1000}s`, entries } : null;
    }
    default:
      return null;
  }
}

/**
 * Checks a display name for the names filter. Returns null when it's fine,
 * otherwise { name, reason } with the replacement nickname.
 */
function cleanName(name, compiled, zalgoThreshold, fallback) {
  let out = String(name ?? "");
  let reason = null;
  if (maxCombiningRun(out) >= zalgoThreshold) {
    out = stripZalgo(out).trim();
    reason = "zalgo";
  }
  if (matchWords(compiled.words, out)) return { name: fallback, reason: "blocked word" };
  if (!reason) return null;
  return { name: (out || fallback).slice(0, 32), reason };
}

module.exports = {
  normalise, wordSource, regexProblem, compileWords, matchWords,
  findInvite, linkHosts, hostAllowed, findBadLink, parseHost, normaliseHost,
  capsPercent, countEmojis, countMentions, hasMassMention, countNewlines, maxCombiningRun, stripZalgo,
  SpamTracker, compileGuild, settingFor, describeSetting, roleExempt, detect, cleanName, defaultsFor,
  TYPES,
};
