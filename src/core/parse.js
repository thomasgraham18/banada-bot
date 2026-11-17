/**
 * Parsers for user input. Every parser throws a UserError with a helpful
 * message on bad input, so handlers can call them without checks:
 *
 *   const ms = parse.duration(options.getString("duration"));   // "1h30m"
 *   const message = await parse.fetchMessage(interaction, link);
 */
const { UserError } = require("./errors");

// ---------------------------------------------------------------- duration

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60e3, min: 60e3, mins: 60e3, minute: 60e3, minutes: 60e3,
  h: 3600e3, hr: 3600e3, hrs: 3600e3, hour: 3600e3, hours: 3600e3,
  d: 86400e3, day: 86400e3, days: 86400e3,
  w: 604800e3, wk: 604800e3, week: 604800e3, weeks: 604800e3,
  mo: 2592000e3, month: 2592000e3, months: 2592000e3, // 30 days
  y: 31536000e3, yr: 31536000e3, year: 31536000e3, years: 31536000e3, // 365 days
};

/**
 * "10m", "1h30m", "2d 4h", "1 week", "90" (bare number = minutes) -> ms.
 * @param {{ min?: number, max?: number }} [limits] in ms
 */
function duration(text, { min = 1000, max = 10 * 31536000e3 } = {}) {
  const input = String(text ?? "").trim().toLowerCase();
  if (!input) throw new UserError("Give a duration such as `10m`, `1h30m` or `2d`.");

  let ms;
  if (/^\d+$/.test(input)) ms = Number(input) * 60e3;
  else {
    ms = 0;
    const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
    let consumed = "";
    let m;
    while ((m = re.exec(input))) {
      const unit = UNIT_MS[m[2]];
      if (!unit) throw new UserError(`Unknown time unit "${m[2]}". Use s, m, h, d, w, mo or y.`);
      ms += Number(m[1]) * unit;
      consumed += m[0];
    }
    if (!ms || consumed.replace(/\s/g, "") !== input.replace(/[\s,]|and/g, ""))
      throw new UserError(`"${text}" is not a duration. Try \`10m\`, \`1h30m\` or \`2d\`.`);
  }

  if (ms < min) throw new UserError(`That's too short; the minimum is ${formatDuration(min)}.`);
  if (ms > max) throw new UserError(`That's too long; the maximum is ${formatDuration(max)}.`);
  return Math.round(ms);
}

/** 5400000 -> "1h 30m". Shows at most `parts` units. */
function formatDuration(ms, parts = 3) {
  let rest = Math.max(0, Math.round(ms / 1000));
  const units = [["y", 31536000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  const out = [];
  for (const [label, size] of units) {
    if (rest >= size) {
      out.push(`${Math.floor(rest / size)}${label}`);
      rest %= size;
    }
    if (out.length === parts) break;
  }
  return out.join(" ") || "0s";
}

/**
 * A point in time: ISO date ("2026-12-25", "2026-12-25 18:00"), a unix
 * timestamp, a Discord timestamp (<t:1790000000:F>) or a relative duration
 * ("2d", "in 3h").
 */
function date(text, { future = true } = {}) {
  const input = String(text ?? "").trim();
  let result;
  const discord = /^<t:(\d+)(?::\w)?>$/.exec(input);
  if (discord) result = new Date(Number(discord[1]) * 1000);
  else if (/^\d{9,13}$/.test(input)) result = new Date(Number(input) * (input.length <= 10 ? 1000 : 1));
  else if (/^\d{4}-\d{2}-\d{2}/.test(input)) result = new Date(input.replace(" ", "T"));
  else {
    try {
      result = new Date(Date.now() + duration(input.replace(/^in\s+/i, "")));
    } catch {
      result = new Date(NaN);
    }
  }
  if (Number.isNaN(result.getTime()))
    throw new UserError(`"${text}" is not a date. Use \`2026-12-25 18:00\`, a Discord timestamp or \`2d\`.`);
  if (future && result.getTime() <= Date.now()) throw new UserError("That date is in the past.");
  return result;
}

/** Discord timestamp markup: <t:unix:R> etc. */
const timestamp = (when, style = "R") => `<t:${Math.floor(new Date(when).getTime() / 1000)}:${style}>`;

// ---------------------------------------------------------------- colour

const NAMED_COLOURS = {
  red: 0xed4245, orange: 0xe67e22, yellow: 0xfee75c, green: 0x57f287, cyan: 0x1abc9c,
  teal: 0x1abc9c, blue: 0x3498db, blurple: 0x5865f2, purple: 0x9b59b6, violet: 0x9b59b6,
  pink: 0xeb459e, magenta: 0xe91e63, brown: 0xa0522d, white: 0xffffff, grey: 0x95a5a6,
  gray: 0x95a5a6, black: 0x010101, gold: 0xf1c40f, navy: 0x34495e, invisible: 0x2b2d31,
};

/** "#ff00aa", "ff00aa", "#f0a", "red", "random" -> integer. */
function colour(text) {
  const input = String(text ?? "").trim().toLowerCase().replace(/^#|^0x/, "");
  if (input === "random") return Math.floor(Math.random() * 0xffffff);
  if (input in NAMED_COLOURS) return NAMED_COLOURS[input];
  if (/^[0-9a-f]{6}$/.test(input)) return parseInt(input, 16);
  if (/^[0-9a-f]{3}$/.test(input)) return parseInt(input.replace(/./g, "$&$&"), 16);
  throw new UserError(`"${text}" is not a colour. Use a hex code like \`#ff8800\` or a name like \`red\`.`);
}

const hex = (n) => `#${Number(n).toString(16).padStart(6, "0").toUpperCase()}`;

// ---------------------------------------------------------------- emoji

const CUSTOM_EMOJI = /^<(a?):(\w{1,32}):(\d{15,25})>$/;
// One emoji "grapheme": pictographs with modifiers / ZWJ sequences, flags, keycaps.
const UNICODE_EMOJI =
  /^(?:\p{RI}\p{RI}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{EMod})?(?:‍\p{Extended_Pictographic}(?:️|\p{EMod})?)*|\p{Emoji_Presentation})$/u;

/**
 * Parses one emoji. Returns
 *   { id, name, animated, custom, text, identifier }
 * `text` is how to write it in a message; `identifier` is what message.react() takes.
 * With `client`, custom emojis the bot cannot use are rejected.
 */
function emoji(text, client) {
  const input = String(text ?? "").trim();
  const custom = CUSTOM_EMOJI.exec(input);
  if (custom) {
    const [, a, name, id] = custom;
    if (client && !client.emojis.cache.has(id) && !client.application?.emojis?.cache.has(id))
      throw new UserError(`I can't use ${input}: I'm not in the server it comes from.`);
    return { id, name, animated: Boolean(a), custom: true, text: input, identifier: `${a ? "a:" : ""}${name}:${id}` };
  }
  if (UNICODE_EMOJI.test(input))
    return { id: null, name: input, animated: false, custom: false, text: input, identifier: input };
  throw new UserError(`"${input.slice(0, 50)}" is not an emoji.`);
}

/** Splits "🍁 <:a:1> 👍" or "🍁,👍" into parsed emojis. */
function emojis(text, client) {
  // Split on spaces/commas, pull out custom emojis, then split the rest into
  // graphemes so "⭐🍁" (no separator) also works.
  return String(text ?? "")
    .split(/[\s,]+/)
    .flatMap((piece) => piece.split(/(<a?:\w+:\d+>)/))
    .filter(Boolean)
    .flatMap((part) => (CUSTOM_EMOJI.test(part) ? [part] : [...new Intl.Segmenter().segment(part)].map((s) => s.segment)))
    .map((p) => emoji(p, client));
}

/** A comparable key for an emoji or a discord.js ReactionEmoji. */
const emojiKey = (e) => (e?.id ? String(e.id) : String(e?.name ?? e ?? "").replace(/️/g, ""));

// ---------------------------------------------------------------- messages

const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;

/** A message link or raw ID -> { guildId?, channelId?, messageId }. */
function messageLink(text) {
  const input = String(text ?? "").trim();
  const link = MESSAGE_LINK.exec(input);
  if (link) return { guildId: link[1], channelId: link[2], messageId: link[3] };
  if (/^\d{15,25}$/.test(input)) return { messageId: input };
  const pair = /^(\d{15,25})-(\d{15,25})$/.exec(input); // "channelId-messageId" (Shift+copy ID)
  if (pair) return { channelId: pair[1], messageId: pair[2] };
  throw new UserError("Give a message link (Right-click → Copy Message Link) or a message ID.");
}

/**
 * Fetches the message a link/ID points at. Raw IDs are looked up in
 * `fallbackChannel` (default: the channel the command was used in).
 */
async function fetchMessage(interaction, text, fallbackChannel = interaction.channel) {
  const ref = messageLink(text);
  if (ref.guildId && ref.guildId !== interaction.guildId)
    throw new UserError("That message is in a different server.");
  const channel = ref.channelId
    ? await interaction.guild.channels.fetch(ref.channelId).catch(() => null)
    : fallbackChannel;
  if (!channel?.isTextBased()) throw new UserError("I can't find the channel of that message.");
  const message = await channel.messages.fetch(ref.messageId).catch(() => null);
  if (!message) throw new UserError("I can't find that message (or can't read that channel).");
  return message;
}

module.exports = {
  duration,
  formatDuration,
  date,
  timestamp,
  colour,
  hex,
  NAMED_COLOURS,
  emoji,
  emojis,
  emojiKey,
  messageLink,
  fetchMessage,
};
