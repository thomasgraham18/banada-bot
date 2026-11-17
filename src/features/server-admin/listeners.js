/**
 * server-admin listeners:
 *   - honeypot (messageCreate): punish anyone non-staff who posts in a bait channel
 *   - autonick (guildMemberAdd): give new members the /settings autonick nickname
 *   - joinlogs (guildMemberAdd/Remove): log joins and leaves
 *
 * All config reads are cached (core config + the honeypot guildCache), so
 * nothing here queries the database per message.
 */
const { PermissionFlagsBits: P } = require("discord.js");
const { listeners, config, guard, punish, logAction, parse, script } = require("../../core");
const store = require("./db");

const { KEYS } = config;

// A raider often posts several messages at once. Only punish the first one;
// later ones are just deleted. Key "guildId:userId" -> expiry time.
const recentlyPunished = new Map();
const DEDUPE_MS = 30_000;

/** Durations for punishments that need one (others are permanent). */
const HONEYPOT_DURATION = { timeout: 24 * 3600e3 };

/** Nickname for a new member, with {user.name} etc. substituted, cut to Discord's 32 chars. */
const autonickFor = (template, member) =>
  script.substitute(template, script.variables({ member, guild: member.guild })).slice(0, 32);

async function honeypot(client, message) {
  if (!message.inGuild() || message.author.bot || message.webhookId) return;
  const punishment = store.honeypots.get(message.guildId).get(message.channelId);
  if (!punishment) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || guard.isStaff(member) || guard.isAdmin(member)) return;

  const key = `${message.guildId}:${member.id}`;
  const now = Date.now();
  if ((recentlyPunished.get(key) ?? 0) > now) {
    await message.delete().catch(() => {});
    return;
  }
  recentlyPunished.set(key, now + DEDUPE_MS);
  // Keep the map small.
  for (const [k, until] of recentlyPunished) if (until <= now) recentlyPunished.delete(k);

  const result = await punish(member, punishment, {
    reason: `Honeypot: posted in #${message.channel.name}`,
    duration: HONEYPOT_DURATION[punishment],
    message,
    silent: false,
  });
  if (!result.ok)
    await logAction(message.guild, "honeypot", {
      title: "Honeypot triggered, but punishing failed",
      colour: 0xed4245,
      user: member.user,
      fields: [
        { name: "Channel", value: `<#${message.channelId}>` },
        { name: "Punishment", value: punishment },
        { name: "Error", value: result.error ?? "unknown", inline: false },
      ],
    });
}

async function autonick(client, member) {
  const template = config.get(member.guild.id, KEYS.AUTONICK);
  if (!template || member.user.bot) return;
  // Skip quietly when we can't: no permission, or the member is above the bot.
  if (!member.guild.members.me?.permissions.has(P.ManageNicknames) || !member.manageable) return;
  const nick = autonickFor(template, member).trim();
  if (nick) await member.setNickname(nick, "/settings autonick").catch(() => {});
}

async function joinLog(client, member) {
  if (!config.get(member.guild.id, KEYS.JOINLOG_CHANNEL)) return;
  const age = Date.now() - member.user.createdTimestamp;
  await logAction(member.guild, "join", {
    title: "Member joined",
    colour: 0x43b581,
    user: member.user,
    description: `${member} joined.${age < 7 * 86400e3 ? "\n⚠️ **New account**" : ""}`,
    fields: [
      { name: "Account created", value: `${parse.timestamp(member.user.createdAt, "f")} (${parse.timestamp(member.user.createdAt)})` },
      { name: "Member count", value: String(member.guild.memberCount) },
    ],
  });
}

async function leaveLog(client, member) {
  if (!config.get(member.guild.id, KEYS.JOINLOG_CHANNEL)) return;
  const user = member.user ?? (await client.users.fetch(member.id).catch(() => null));
  if (!user) return;
  const roles = member.partial ? [] : member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`);
  await logAction(member.guild, "leave", {
    title: "Member left",
    colour: 0xed4245,
    user,
    description: `<@${user.id}> left.`,
    fields: [
      { name: "Joined", value: member.joinedAt ? parse.timestamp(member.joinedAt) : "unknown" },
      { name: "Member count", value: String(member.guild.memberCount) },
      ...(roles.length ? [{ name: "Roles", value: roles.slice(0, 30).join(" "), inline: false }] : []),
    ],
  });
}

module.exports = function setup() {
  // module "antiraid": /access module antiraid (or /ignore) can switch it off in a channel.
  // First of all message listeners: a bait-channel message must not trigger anything else.
  listeners.on("messageCreate", { name: "server-admin:honeypot", module: "antiraid", priority: 5 }, async (client, message) => {
    if (store.honeypots.get(message.guildId ?? "")?.has?.(message.channelId)) listeners.consume(message);
    await honeypot(client, message);
  });
  // Autonick and join logs are server-wide settings rather than per-channel features,
  // so they don't declare a module/event; clearing the setting turns them off.
  listeners.on("guildMemberAdd", { name: "server-admin:autonick" }, autonick);
  listeners.on("guildMemberAdd", { name: "server-admin:joinlog" }, joinLog);
  listeners.on("guildMemberRemove", { name: "server-admin:leavelog" }, leaveLog);
};

module.exports.autonickFor = autonickFor;
