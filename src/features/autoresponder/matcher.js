/**
 * The trigger matcher shared by /autoresponder and /reaction.
 *
 * Pure functions only (no Discord, no database) so it can be unit-tested.
 *
 * Matching is case-insensitive and whitespace-insensitive: both the trigger
 * and the message go through normalise() (lower case, trimmed, runs of
 * whitespace collapsed to one space). A trigger works in one of these modes:
 *
 *   trigger        strict  mode       fires when the message...
 *   -------------  ------  ---------  -------------------------------------------
 *   hello          no      word       contains "hello" as a whole word/phrase
 *                                     ("hello there" yes, "othello" no)
 *   hello          yes     exact      is exactly "hello"
 *   hi*            any     starts     starts with "hi"            ("hiya" yes)
 *   *bye           any     ends       ends with "bye"             ("goodbye" yes)
 *   *lol*          any     contains   contains "lol" anywhere      ("lollipop" yes)
 *   good * day     any     wildcard   matches the pattern, `*` = anything
 *                                     ("good sunny day" yes)
 *
 * A `*` in a trigger is always a wildcard, so a literal asterisk can't be
 * matched. Patterns with `*` are anchored to the whole message.
 *
 * Word boundaries are Unicode-aware (letters/digits of any script count as
 * word characters), and are only applied on a side of the trigger that starts
 * or ends with a word character, so ":)" still matches in "nice :)".
 *
 * Hot path design: compile() builds, per guild,
 *   - a Map for exact triggers (one hash lookup per message), and
 *   - ONE combined regex over every other trigger, used as a quick "does
 *     anything match at all?" gate. Almost every message fails this single
 *     test, so the per-trigger regexes only run when something matched.
 */

const MAX_TRIGGER_LENGTH = 100; // autocomplete values are capped at 100 chars

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const BEFORE_IS_NOT_WORD = "(?<![\\p{L}\\p{N}_])";
const AFTER_IS_NOT_WORD = "(?![\\p{L}\\p{N}_])";

/** Lower case, trimmed, whitespace collapsed. Used for triggers and messages. */
const normalise = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Normalises and validates a trigger typed by a user. Returns the stored form,
 * or throws an Error with a user-facing message (callers wrap it in UserError).
 */
function cleanTrigger(text) {
  const trigger = normalise(text).replace(/\*{2,}/g, "*"); // "**" means the same as "*"
  if (!trigger) throw new Error("The trigger can't be empty.");
  if (!trigger.replace(/[*\s]/g, "")) throw new Error("The trigger needs at least one character besides `*`.");
  if (trigger.length > MAX_TRIGGER_LENGTH) throw new Error(`Triggers can be at most ${MAX_TRIGGER_LENGTH} characters.`);
  return trigger;
}

/** "word" | "exact" | "starts" | "ends" | "contains" | "wildcard" */
function modeOf(trigger, strict = false) {
  if (!trigger.includes("*")) return strict ? "exact" : "word";
  const inner = trigger.slice(1, -1);
  const starts = trigger.startsWith("*");
  const ends = trigger.endsWith("*");
  if (starts && ends && !inner.includes("*")) return "contains";
  if (ends && !starts && !trigger.slice(0, -1).includes("*")) return "starts";
  if (starts && !ends && !trigger.slice(1).includes("*")) return "ends";
  return "wildcard";
}

const MODE_LABELS = {
  word: "whole word",
  exact: "exact message",
  starts: "starts with",
  ends: "ends with",
  contains: "contains",
  wildcard: "wildcard",
};

/** Human label for list output, e.g. "starts with". */
const describe = (trigger, strict) => MODE_LABELS[modeOf(trigger, strict)];

/** Regex source (no flags) for a non-exact trigger. Use with the "su" flags. */
function sourceFor(trigger, strict = false) {
  const mode = modeOf(trigger, strict);
  if (mode === "exact") return `^${escapeRegex(trigger)}$`;
  if (mode === "word") {
    const before = WORD_CHAR.test(trigger[0]) ? BEFORE_IS_NOT_WORD : "";
    const after = WORD_CHAR.test(trigger[trigger.length - 1]) ? AFTER_IS_NOT_WORD : "";
    return `${before}${escapeRegex(trigger)}${after}`;
  }
  // Any pattern with `*`: anchor to the whole message, `*` = any characters.
  return `^${trigger.split("*").map(escapeRegex).join(".*")}$`;
}

/**
 * Matches a `*` trigger against normalised text without a regex. The regex
 * form (`^a.*b.*c$`) backtracks polynomially: "*a*a*a*b" against 500 "a"s
 * blocked the event loop for ~20 s. Greedy leftmost matching of the literal
 * segments gives the same answer in linear time.
 */
function globMatch(trigger, input) {
  const segments = trigger.split("*");
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (input.length < first.length + last.length || !input.startsWith(first) || !input.endsWith(last)) return false;
  let pos = first.length;
  const end = input.length - last.length;
  for (const segment of segments.slice(1, -1)) {
    const at = input.indexOf(segment, pos);
    if (at < 0 || at + segment.length > end) return false;
    pos = at + segment.length;
  }
  return true;
}

/** A test(input) function for one non-exact trigger (input already normalised). */
function testerFor(trigger, strict = false) {
  if (trigger.includes("*")) return (input) => globMatch(trigger, input);
  const regex = new RegExp(sourceFor(trigger, strict), "su");
  return (input) => regex.test(input);
}

/** Does one trigger match a message? (Convenience; the listeners use compile().) */
const matches = (trigger, strict, text) => {
  const input = normalise(text);
  return modeOf(trigger, strict) === "exact" ? input === trigger : testerFor(trigger, strict)(input);
};

/**
 * Compiles triggers for fast matching.
 * @param {Array<{ trigger: string, strict?: boolean }>} entries any objects
 *   with a normalised `trigger`; they are returned as-is from match().
 * @returns {{ size: number, match(text: string): object[] }}
 *   match() takes RAW message text and returns every matching entry: exact
 *   matches first, then longer (more specific) triggers before shorter ones.
 */
function compile(entries) {
  const exact = new Map(); // trigger -> entries
  const others = []; // { entry, regex }
  for (const entry of entries) {
    if (modeOf(entry.trigger, entry.strict) === "exact") {
      if (!exact.has(entry.trigger)) exact.set(entry.trigger, []);
      exact.get(entry.trigger).push(entry);
    } else {
      others.push({ entry, test: testerFor(entry.trigger, entry.strict) });
    }
  }
  others.sort((a, b) => b.entry.trigger.length - a.entry.trigger.length);

  // One alternation of every word trigger: a single test() rejects most
  // messages. `*` triggers stay out of it (see globMatch) and are checked directly.
  const words = others.filter((o) => !o.entry.trigger.includes("*"));
  const gate = words.length ? new RegExp(words.map((o) => `(?:${sourceFor(o.entry.trigger, o.entry.strict)})`).join("|"), "su") : null;
  const hasGlobs = words.length < others.length;

  return {
    size: entries.length,
    match(text) {
      const input = normalise(text);
      if (!input) return [];
      const found = [...(exact.get(input) ?? [])];
      if (hasGlobs || (gate && gate.test(input))) for (const o of others) if (o.test(input)) found.push(o.entry);
      return found;
    },
  };
}

/**
 * Default "looks like a bot command" check for /autoresponder's
 * ignore_command_check. This bot has no text prefix, so it treats a message
 * as a command when it starts with a common prefix character directly
 * followed by a letter: "!play", "?help", ".ban", ";rank", ",fm", "$bal", "/x".
 */
const looksLikeCommand = (content) => /^[!?.;,$/][\p{L}]/u.test(String(content ?? "").trimStart());

module.exports = {
  MAX_TRIGGER_LENGTH,
  normalise,
  cleanTrigger,
  modeOf,
  describe,
  sourceFor,
  matches,
  compile,
  looksLikeCommand,
};
