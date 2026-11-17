/**
 * Pure helpers for /settings (kept apart from the command so tests can use them).
 */
const { PermissionFlagsBits: P } = require("discord.js");
const { config } = require("../../core");

const { KEYS } = config;

/** `/settings clear setting` choice -> guild_config key. */
const CLEARABLE = {
  muted: KEYS.MUTED_ROLE,
  imuted: KEYS.IMUTED_ROLE,
  rmuted: KEYS.RMUTED_ROLE,
  jailrole: KEYS.JAIL_ROLE,
  premiumrole: KEYS.PREMIUM_ROLE,
  baserole: KEYS.BASE_ROLE,
  dj: KEYS.DJ_ROLE,
  modlog: KEYS.MODLOG_CHANNEL,
  jail: KEYS.JAIL_CHANNEL,
  jailmsg: KEYS.JAIL_MESSAGE,
  autonick: KEYS.AUTONICK,
  joinlogs: KEYS.JOINLOG_CHANNEL,
};

/** What `/settings reset` wipes (moderation config only; staff roles are cleared separately). */
const MODERATION_KEYS = [
  KEYS.MUTED_ROLE, KEYS.IMUTED_ROLE, KEYS.RMUTED_ROLE, KEYS.JAIL_ROLE, KEYS.JAIL_CHANNEL,
  KEYS.JAIL_MESSAGE, KEYS.JAIL_STRIP_ROLES, KEYS.MODLOG_CHANNEL,
];

const ROLE_KEYS = new Set([KEYS.MUTED_ROLE, KEYS.IMUTED_ROLE, KEYS.RMUTED_ROLE, KEYS.JAIL_ROLE, KEYS.PREMIUM_ROLE, KEYS.BASE_ROLE, KEYS.DJ_ROLE]);
const CHANNEL_KEYS = new Set([KEYS.JAIL_CHANNEL, KEYS.MODLOG_CHANNEL, KEYS.JOINLOG_CHANNEL]);

/**
 * Channel overwrites applied by the "apply to every channel" button after
 * setting a muted role. Values are denied for the role.
 */
const MUTE_OVERWRITES = {
  muted: { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false },
  imuted: { AttachFiles: false, EmbedLinks: false },
  rmuted: { AddReactions: false, UseExternalEmojis: false },
};

/** Human-readable value for /settings config. Unknown keys from other packages are shown raw. */
function describeValue(key, value) {
  if (value === undefined || value === null) return "*not set*";
  if (typeof value === "boolean") return value ? "✅ on" : "❌ off";
  if (ROLE_KEYS.has(key) && /^\d+$/.test(String(value))) return `<@&${value}>`;
  if ((CHANNEL_KEYS.has(key) || /_channel$/.test(key)) && /^\d+$/.test(String(value))) return `<#${value}>`;
  if (/_role$/.test(key) && /^\d+$/.test(String(value))) return `<@&${value}>`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = text.replace(/\s+/g, " ").replace(/`/g, "'"); // backticks would break the code span
  return `\`${oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine || " "}\``;
}

/** Lines for /settings config, WP1 keys first in a fixed order, then any other package's keys. */
function configLines(all) {
  const known = Object.values(KEYS);
  const lines = known.map((key) => `**${key}**: ${describeValue(key, all[key])}`);
  const extra = Object.keys(all).filter((k) => !known.includes(k)).sort();
  return [...lines, ...extra.map((key) => `**${key}**: ${describeValue(key, all[key])}`)];
}

/** Every non-thread channel a role overwrite makes sense on. */
const overwritableChannels = (guild) => [...guild.channels.cache.values()].filter((c) => !c.isThread() && c.permissionOverwrites);

const BOT_OVERWRITE_PERMS = [P.ManageChannels, P.ManageRoles];

module.exports = { CLEARABLE, MODERATION_KEYS, MUTE_OVERWRITES, describeValue, configLines, overwritableChannels, BOT_OVERWRITE_PERMS };
