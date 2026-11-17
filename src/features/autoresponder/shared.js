/**
 * Small helpers shared by the /autoresponder and /reaction command files.
 */
const { UserError, parse } = require("../../core");
const matcher = require("./matcher");

/** Reads and normalises a trigger option; bad input becomes a UserError. */
function triggerOption(interaction, name = "trigger") {
  try {
    return matcher.cleanTrigger(interaction.options.getString(name, true));
  } catch (err) {
    throw new UserError(err.message);
  }
}

/** `trigger` for embeds, safe against backticks in the trigger itself. */
const code = (text) => `\`${String(text).replace(/`/g, "ˋ")}\``;

/** "`hi*` (starts with)" */
const showTrigger = (trigger, strict) => `${code(trigger)} *(${matcher.describe(trigger, strict)})*`;

/** One emoji typed by the user, as stored: { key, text, identifier }. */
function emojiOption(interaction, name, client) {
  const parsed = parse.emoji(interaction.options.getString(name, true), client);
  return { key: parse.emojiKey(parsed), text: parsed.text, identifier: parsed.identifier };
}

/** Autocomplete label for a stored emoji: custom emojis can't render in choices. */
const emojiLabel = (text) => {
  const custom = /^<a?:(\w+):\d+>$/.exec(text);
  return custom ? `:${custom[1]}:` : text;
};

/** The help line shown under add/update and in lists. */
const MATCHING_HELP =
  "Matching ignores case. `word` = whole word anywhere, `strict` = whole message, " +
  "`hi*` = starts with, `*bye` = ends with, `*lol*` = contains, `good * day` = wildcard.";

module.exports = { triggerOption, code, showTrigger, emojiOption, emojiLabel, MATCHING_HELP };
