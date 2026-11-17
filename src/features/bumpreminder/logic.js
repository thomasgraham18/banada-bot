/**
 * Pure helpers for /bumpreminder (no Discord, no database), so they can be
 * unit-tested with plain objects.
 */

/** DISBOARD's bot user. Only its messages can count as a bump. */
const DISBOARD_ID = "302050872383242240";

/** DISBOARD's bump cooldown. */
const BUMP_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/** How long autoclean waits before deleting a stray message. */
const AUTOCLEAN_DELAY_MS = 5000;

const DEFAULT_REMINDER = JSON.stringify({
  embed: {
    title: "Time to bump!",
    description: "The server can be bumped again. Run **/bump** to help {guild.name} grow.",
    color: "#5865F2",
  },
});

const DEFAULT_THANKYOU = JSON.stringify({
  embed: {
    title: "Thanks for bumping!",
    description: "Thank you {user.mention}! I'll remind everyone to bump again {next_bump}.",
    color: "#43B581",
  },
});

/** Extra variables, for `view` output. */
const REMINDER_VARIABLES = {
  "{last_bumper}": "Mention of the last member who bumped",
  "{last_bumper.id}": "ID of the last member who bumped",
};
const THANKYOU_VARIABLES = {
  "{user}": "The member who just bumped (all {user.*} variables work)",
  "{next_bump}": "When the next bump is possible (relative timestamp)",
};

/**
 * Decides whether a message is DISBOARD confirming a successful /bump.
 *
 * Takes anything shaped like a discord.js Message (a real Message works, and
 * so does a plain object in tests):
 *   {
 *     author: { id },
 *     channelId,
 *     embeds: [{ description }],
 *     interactionMetadata: { user: { id } },        // current API
 *     interaction: { commandName, user: { id } },   // deprecated, fallback
 *   }
 *
 * Returns { bumperId } (bumperId may be null if Discord didn't say who ran
 * the command), or null when it isn't a successful bump. With `channelId`,
 * only messages in that channel count.
 */
function detectBump(message, { channelId } = {}) {
  if (!message || message.author?.id !== DISBOARD_ID) return null;
  if (channelId && message.channelId !== channelId) return null;

  // If Discord tells us which command DISBOARD answered, it must be /bump.
  const commandName = message.interaction?.commandName ?? message.interactionMetadata?.name ?? null;
  if (commandName && commandName.toLowerCase() !== "bump") return null;

  // DISBOARD's success embed reads "Bump done! :thumbsup: ...". Failures
  // ("Please wait another 87 minutes...") use a different description.
  const done = (message.embeds ?? []).some((e) => /bump done/i.test(String(e?.description ?? e?.data?.description ?? "")));
  if (!done) return null;

  const bumperId = message.interactionMetadata?.user?.id ?? message.interaction?.user?.id ?? null;
  return { bumperId };
}

/**
 * The state of one permission in a channel overwrite: true (allowed),
 * false (denied) or null (inherited). `overwrite` has allow/deny with has().
 * Used to put the channel back exactly as it was after an autolock.
 */
function overwriteState(overwrite, flag) {
  if (!overwrite) return null;
  if (overwrite.allow?.has?.(flag)) return true;
  if (overwrite.deny?.has?.(flag)) return false;
  return null;
}

/**
 * allowedMentions for the reminder. Not pingable: nobody is pinged. Pingable:
 * users and roles written in the script are pinged (never @everyone/@here).
 */
const reminderMentions = (pingable) => (pingable ? { parse: ["users", "roles"] } : { parse: [] });

/**
 * When pingable is on but the script mentions nobody, put the last bumper in
 * front so the reminder actually pings someone.
 */
function withPing(payload, pingable, lastBumperId) {
  if (!pingable || !lastBumperId) return payload;
  const content = payload.content && payload.content !== "​" ? payload.content : "";
  if (/<@[!&]?\d+>/.test(content)) return payload;
  return { ...payload, content: `<@${lastBumperId}>${content ? ` ${content}` : ""}`.slice(0, 2000) };
}

/** Which script to use: NULL = default, "" = switched off (thank-you only). */
const reminderScript = (settings) => settings.reminder_script || DEFAULT_REMINDER;
const thankyouScript = (settings) => (settings.thankyou_script == null ? DEFAULT_THANKYOU : settings.thankyou_script || null);

module.exports = {
  DISBOARD_ID,
  BUMP_COOLDOWN_MS,
  AUTOCLEAN_DELAY_MS,
  DEFAULT_REMINDER,
  DEFAULT_THANKYOU,
  REMINDER_VARIABLES,
  THANKYOU_VARIABLES,
  detectBump,
  overwriteState,
  reminderMentions,
  withPing,
  reminderScript,
  thankyouScript,
};
