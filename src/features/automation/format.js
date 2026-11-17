/**
 * Pure helpers for /automation: no Discord, no database. Everything here is
 * unit-tested in automation.test.js.
 *
 *   formatCount(1234, { prettify: true, currency: "$" })   -> "$1.2K"
 *   counterName("Members: {count}", "1,234")               -> "Members: 1,234"
 *   timerInterval("30m")                                   -> 1800000 (min 5m)
 *   periodStart("weekly", now)                             -> Monday 00:00 UTC
 *   boardScript(stored, entries, ...)                      -> a script string
 */
const { parse, script, UserError } = require("../../core");

// ---------------------------------------------------------------- constants

/** Counter sources (`/automation counter add option`). label = default name. */
const COUNTER_OPTIONS = {
  members: "Members",
  humans: "Humans",
  bots: "Bots",
  online: "Online",
  boosts: "Boosts",
  boost_tier: "Boost Level",
  channels: "Channels",
  roles: "Roles",
  voice: "In Voice",
  banned: "Banned",
};

/** Discord allows ~2 channel renames per 10 minutes, so never update faster. */
const COUNTER_INTERVAL_MS = 10 * 60_000;

const TIMER_MIN_MS = 5 * 60_000;
const TIMER_MAX_MS = 30 * 86_400_000;
const TIMER_DEFAULT = "1h";

const LEADERBOARD_KINDS = { messages: "Messages", voice: "Voice", levels: "Levels", invites: "Invites" };
const TIMEFRAMES = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", alltime: "All Time" };
const LEADERBOARD_SIZE = 10;
const LEADERBOARD_REFRESH_MS = 10 * 60_000;

/** Ranks without a custom emote show these. */
const DEFAULT_EMOTES = { 1: "🥇", 2: "🥈", 3: "🥉" };
const defaultEmote = (rank) => DEFAULT_EMOTES[rank] ?? `\`#${rank}\``;

// ---------------------------------------------------------------- counters

/**
 * 1234 -> "1,234" (plain) or "1.2K" (prettify). `currency` is a symbol put in
 * front ("$", "€"). Bleed's currency option probably fetched prices; we only
 * format (see the package file: STRETCH).
 */
function formatCount(value, { prettify = false, currency = null } = {}) {
  const n = Number(value) || 0;
  const text = prettify
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
    : n.toLocaleString("en-US");
  return `${currency ?? ""}${text}`;
}

/**
 * The template a counter renames its channel with. A `name` containing
 * {count} is used as-is; any other name becomes a label ("Members" ->
 * "Members: {count}"); no name uses the option's label.
 */
function counterTemplate(option, name) {
  const text = String(name ?? "").trim();
  if (!text) return `${COUNTER_OPTIONS[option] ?? option}: {count}`;
  if (/\{(count|value)\}/i.test(text)) return text;
  return `${text}: {count}`;
}

/** Fills a counter template. Channel names are at most 100 characters. */
function counterName(template, formatted) {
  return String(template).replace(/\{(count|value)\}/gi, formatted).trim().slice(0, 100) || formatted;
}

// ---------------------------------------------------------------- timers

/** A timer interval option -> ms (default 1h, between 5 minutes and 30 days). */
function timerInterval(text) {
  return parse.duration(text ?? TIMER_DEFAULT, { min: TIMER_MIN_MS, max: TIMER_MAX_MS });
}

// ---------------------------------------------------------------- periods

/**
 * Activity is stored in daily buckets keyed by the bucket's UTC midnight;
 * period_start 0 is the all-time total. A timeframe "resets" simply because
 * its window moves: daily starts at 00:00 UTC, weekly on Monday 00:00 UTC,
 * monthly on the 1st 00:00 UTC. Returns the first bucket in the window.
 */
function periodStart(timeframe, now = Date.now()) {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  switch (timeframe) {
    case "daily":
      return midnight;
    case "weekly": {
      const sinceMonday = (d.getUTCDay() + 6) % 7; // Sunday = 0 -> 6 days since Monday
      return midnight - sinceMonday * 86_400_000;
    }
    case "monthly":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case "alltime":
      return 0;
    default:
      throw new UserError(`Unknown timeframe "${timeframe}".`);
  }
}

/** UTC midnight of the day containing `now` (the bucket new activity goes into). */
const dayStart = (now = Date.now()) => periodStart("daily", now);

// ---------------------------------------------------------------- leaderboards

/** How a value reads on a board ("1,234 messages", "3h 20m", "Level 5 (1,234 XP)"). */
function formatValue(kind, entry) {
  const value = Number(entry.value) || 0;
  switch (kind) {
    case "messages":
      return `${value.toLocaleString("en-US")} message${value === 1 ? "" : "s"}`;
    case "voice":
      // Stored in seconds; show at most two units.
      return parse.formatDuration(value * 1000, 2);
    case "invites":
      return `${value.toLocaleString("en-US")} invite${value === 1 ? "" : "s"}`;
    case "levels":
      return `Level ${entry.level ?? 0} (${Number(entry.xp ?? value).toLocaleString("en-US")} XP)`;
    default:
      return String(value);
  }
}

/** Lines containing one of these are repeated once per leaderboard entry. */
const ENTRY_VARIABLE = /\{(rank|user|value|emote)\}/i;

const DEFAULT_BOARD_SCRIPT = JSON.stringify({
  embed: {
    title: "{kind} leaderboard · {timeframe}",
    description: "{emote} {user} · **{value}**",
    footer: { text: "Updates every 10 minutes" },
    timestamp: true,
  },
});

const BOARD_VARIABLES = {
  "{rank}": "Position on the board (1-10). Lines using an entry variable repeat once per entry",
  "{user}": "Mention of the member at that rank",
  "{value}": "Their score (messages, voice time, level, invites)",
  "{emote}": "The rank's emote (`/automation leaderboard emote`)",
  "{kind}": "Messages, Voice, Levels or Invites",
  "{timeframe}": "Daily, Weekly, Monthly or All Time",
  "{updated}": "When the board was last refreshed (relative)",
};

const EMPTY_BOARD = "*Nobody yet. Get chatting!*";

/**
 * Repeats every line that uses an entry variable once per entry.
 * entries: [{ rank, userId, display, emote }].
 */
function expandEntries(text, entries) {
  const out = [];
  let emptyShown = false;
  for (const line of String(text).split("\n")) {
    if (!ENTRY_VARIABLE.test(line)) {
      out.push(line);
      continue;
    }
    if (!entries.length) {
      if (!emptyShown) out.push(EMPTY_BOARD);
      emptyShown = true;
      continue;
    }
    for (const e of entries)
      out.push(
        line
          .replace(/\{rank\}/gi, String(e.rank))
          .replace(/\{user\}/gi, `<@${e.userId}>`)
          .replace(/\{value\}/gi, e.display)
          .replace(/\{emote\}/gi, e.emote)
          .trim()
      );
  }
  return out.join("\n");
}

/** Applies expandEntries to every string inside a parsed script. */
function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/**
 * Turns a stored board script plus ranked rows into a plain script that
 * core/script.render() can send. rows: [{ userId, value, level?, xp? }]
 * sorted best first; emotes: { [rank]: text }.
 */
function boardScript(stored, kind, rows, emotes = {}) {
  const entries = rows.slice(0, LEADERBOARD_SIZE).map((row, i) => ({
    rank: i + 1,
    userId: row.userId,
    display: formatValue(kind, row),
    emote: emotes[i + 1] ?? defaultEmote(i + 1),
  }));
  const parsed = script.parseScript(stored || DEFAULT_BOARD_SCRIPT);
  return JSON.stringify(mapStrings(parsed, (s) => expandEntries(s, entries)));
}

/** Frame variables for script.render(). */
const boardVars = (kind, timeframe, now = Date.now()) => ({
  kind: LEADERBOARD_KINDS[kind] ?? kind,
  timeframe: TIMEFRAMES[timeframe] ?? timeframe,
  updated: parse.timestamp(now, "R"),
});

module.exports = {
  COUNTER_OPTIONS,
  COUNTER_INTERVAL_MS,
  TIMER_MIN_MS,
  TIMER_MAX_MS,
  TIMER_DEFAULT,
  LEADERBOARD_KINDS,
  TIMEFRAMES,
  LEADERBOARD_SIZE,
  LEADERBOARD_REFRESH_MS,
  DEFAULT_BOARD_SCRIPT,
  BOARD_VARIABLES,
  EMPTY_BOARD,
  defaultEmote,
  formatCount,
  counterTemplate,
  counterName,
  timerInterval,
  periodStart,
  dayStart,
  formatValue,
  expandEntries,
  boardScript,
  boardVars,
};
