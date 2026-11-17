/**
 * Shared vocabulary for the filter package: filter kinds, their default
 * thresholds, punishments and limits. No Discord or database code here.
 */

/** Every filter kind, in the order the slash-command choices show them. */
const TYPES = [
  "words", "invites", "links", "spam", "caps", "mentions", "emojis",
  "newlines", "attachments", "stickers", "zalgo", "names", "massmention",
];

/**
 * What `threshold` means per kind, its default and allowed range. A filter
 * trips when the measured value is >= threshold. Kinds without an entry
 * ignore the threshold.
 */
const THRESHOLDS = {
  spam: { default: 5, min: 2, max: 30, unit: "messages in 5 seconds" },
  caps: { default: 70, min: 1, max: 100, unit: "% capital letters" },
  mentions: { default: 5, min: 1, max: 50, unit: "user/role mentions" },
  emojis: { default: 6, min: 1, max: 100, unit: "emojis" },
  newlines: { default: 10, min: 1, max: 200, unit: "line breaks" },
  attachments: { default: 1, min: 1, max: 10, unit: "attachments" },
  stickers: { default: 1, min: 1, max: 3, unit: "stickers" },
  zalgo: { default: 3, min: 1, max: 50, unit: "stacked accents on one letter" },
  names: { default: 3, min: 1, max: 50, unit: "stacked accents (zalgo) in a name" },
};

/** Short human descriptions, used by /filter config. */
const DESCRIPTIONS = {
  words: "blocked words, wildcards and regex",
  invites: "Discord server invites",
  links: "links to sites not on the whitelist",
  spam: "sending many messages quickly",
  caps: "messages that are mostly capital letters",
  mentions: "mentioning many users or roles",
  emojis: "messages with many emojis",
  newlines: "messages with many line breaks",
  attachments: "file attachments",
  stickers: "stickers",
  zalgo: "zalgo (stacked accent) text",
  names: "bad or zalgo nicknames (renames the member)",
  massmention: "@everyone / @here attempts",
};

/** Punishments a filter can apply. "points" feeds the escalation ladder. */
const PUNISHMENTS = ["delete", "warn", "timeout", "mute", "jail", "kick", "ban", "points"];
/** Punishments a ladder step can apply (points can't recurse, delete is implied). */
const LADDER_PUNISHMENTS = ["warn", "timeout", "mute", "jail", "kick", "ban"];
/** Punishments that use the duration option. */
const TIMED = new Set(["timeout", "mute", "jail", "ban"]);

/** /filter snipe kinds (the snipe command itself belongs to another section). */
const SNIPE_TYPES = ["words", "invites", "links", "images"];

/**
 * Order filters are checked in for a new message. Only the first hit is
 * punished, so the most serious kinds go first. "names" is handled by the
 * member listeners, not on messages.
 */
const CHECK_ORDER = [
  "words", "invites", "massmention", "links", "mentions", "zalgo", "caps",
  "emojis", "newlines", "attachments", "stickers", "spam",
];
/** Edits re-check only the kinds that depend on the text. */
const EDIT_ORDER = ["words", "invites", "massmention", "links", "mentions", "zalgo", "caps", "emojis", "newlines"];

/** Kinds mirrored into Discord AutoMod (see automod.js). */
const AUTOMOD_TYPES = ["words", "invites", "mentions"];
/** Punishments AutoMod can carry out by itself, so mirroring loses nothing. */
const AUTOMOD_PUNISHMENTS = new Set(["delete", "timeout"]);

// Discord AutoMod limits per keyword rule (and our DB limits, so they line up).
const LIMITS = { words: 1000, wordLength: 60, allow: 100, regex: 10, regexLength: 260, urls: 200, ladder: 15 };

const SPAM_WINDOW_MS = 5000;
/** Points decay: one point removed per full day without a new violation. */
const POINT_DECAY_MS = 86400e3;
/** Fewer letters than this and the caps filter ignores the message ("OK", "LOL"). */
const MIN_CAPS_LETTERS = 8;

/** Name used when a nickname has to be replaced entirely. */
const FALLBACK_NAME = "Moderated Name";

/** guild_config keys owned by this package. */
const CONFIG = { POINTS_LIMIT: "filter_points_limit" };

module.exports = {
  TYPES, THRESHOLDS, DESCRIPTIONS, PUNISHMENTS, LADDER_PUNISHMENTS, TIMED, SNIPE_TYPES,
  CHECK_ORDER, EDIT_ORDER, AUTOMOD_TYPES, AUTOMOD_PUNISHMENTS, LIMITS, SPAM_WINDOW_MS,
  POINT_DECAY_MS, MIN_CAPS_LETTERS, FALLBACK_NAME, CONFIG,
};
