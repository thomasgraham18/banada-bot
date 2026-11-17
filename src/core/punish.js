/**
 * Minimal punishment service, shared by filters, honeypots, no-self-react and
 * later the moderation commands.
 *
 *   await punish(member, "timeout", { reason: "Spam", duration: 600_000, moderator, message })
 *
 * Kinds: delete, warn, timeout, mute, imute, rmute, jail, kick, ban, softban
 *  and the reversals: untimeout, unmute, unimute, unrmute, unjail, unban.
 *
 * Each call (except plain "delete") opens a numbered case, sends the /invoke
 * DM / channel message, logs to the modlog channel, and for timed
 * mute/jail schedules the reversal. Returns { ok, case, error }; it never
 * throws for Discord-side failures, because listeners call it.
 */
const db = require("./db");
const config = require("./config");
const scheduler = require("./scheduler");
const script = require("./script");
const { logAction } = require("./log");
const { formatDuration } = require("./parse");
const { botCanManageRole } = require("./guard");

const { KEYS } = config;
const MAX_TIMEOUT_MS = 28 * 86400e3;
const DEFAULT_TIMEOUT_MS = 10 * 60e3;

const ROLE_KINDS = { mute: KEYS.MUTED_ROLE, imute: KEYS.IMUTED_ROLE, rmute: KEYS.RMUTED_ROLE };
const REVERSALS = { mute: "unmute", imute: "unimute", rmute: "unrmute", jail: "unjail", timeout: "untimeout", ban: "unban" };
const KINDS = ["delete", "warn", "timeout", "mute", "imute", "rmute", "jail", "kick", "ban", "softban",
  "untimeout", "unmute", "unimute", "unrmute", "unjail", "unban"];
const COLOURS = { warn: 0xfaa61a, timeout: 0xe67e22, kick: 0xe67e22, ban: 0xed4245, softban: 0xed4245, jail: 0x992d22 };

function openCase(guildId, userId, moderatorId, action, reason, durationMs) {
  return db.transaction(() => {
    const next = (db.get("SELECT MAX(case_id) AS n FROM cases WHERE guild_id = ?", guildId)?.n ?? 0) + 1;
    db.run(
      "INSERT INTO cases (guild_id, case_id, user_id, moderator_id, action, reason, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      guildId, next, userId, moderatorId, action, reason, durationMs, Date.now()
    );
    return next;
  });
}

/** The /invoke message for a punishment, or null. */
const invokeScript = (guildId, punishment, target) =>
  db.get("SELECT script FROM invoke_messages WHERE guild_id = ? AND punishment = ? AND target = ?", guildId, punishment, target)?.script ?? null;

async function sendInvoke(guild, user, kind, vars, channel) {
  const ctx = (member) => ({ member, user, guild, vars });
  const dm = invokeScript(guild.id, kind, "dm");
  if (dm) await user.send(script.render(dm, ctx(null))).catch(() => {});
  const inChannel = invokeScript(guild.id, kind, "channel");
  if (inChannel && channel?.isTextBased()) await channel.send(script.render(inChannel, { ...ctx(null), channel })).catch(() => {});
}

async function applyRole(member, key, add) {
  const roleId = config.get(member.guild.id, key);
  const role = roleId && member.guild.roles.cache.get(roleId);
  if (!role) throw new Error(`no ${key.replace(/_/g, " ")} is set (see /settings)`);
  if (!botCanManageRole(member.guild, role)) throw new Error(`I can't manage ${role.name}`);
  if (add) await member.roles.add(role, "Punishment");
  else await member.roles.remove(role, "Punishment reversed");
}

async function jail(member, add) {
  const guild = member.guild;
  if (add) {
    if (config.get(guild.id, KEYS.JAIL_STRIP_ROLES, false)) {
      const removable = member.roles.cache.filter((r) => r.id !== guild.id && botCanManageRole(guild, r) && r.id !== config.get(guild.id, KEYS.JAIL_ROLE));
      db.run("INSERT OR REPLACE INTO jail_saved_roles (guild_id, user_id, role_ids) VALUES (?, ?, ?)", guild.id, member.id, JSON.stringify([...removable.keys()]));
      await member.roles.remove([...removable.keys()], "Jailed").catch(() => {});
    }
    await applyRole(member, KEYS.JAIL_ROLE, true);
    const channelId = config.get(guild.id, KEYS.JAIL_CHANNEL);
    const message = config.get(guild.id, KEYS.JAIL_MESSAGE);
    const channel = channelId && guild.channels.cache.get(channelId);
    if (channel && message) await script.send(channel, message, { member, guild }).catch(() => {});
  } else {
    await applyRole(member, KEYS.JAIL_ROLE, false);
    const saved = db.get("SELECT role_ids FROM jail_saved_roles WHERE guild_id = ? AND user_id = ?", guild.id, member.id);
    if (saved) {
      const ids = JSON.parse(saved.role_ids).filter((id) => guild.roles.cache.has(id));
      if (ids.length) await member.roles.add(ids, "Unjailed").catch(() => {});
      db.run("DELETE FROM jail_saved_roles WHERE guild_id = ? AND user_id = ?", guild.id, member.id);
    }
  }
}

/**
 * @param {import("discord.js").GuildMember | { guild, user }} target  a member, or { guild, user } for unban
 * @param {string} kind
 * @param {{ reason?: string, duration?: number, moderator?: import("discord.js").User, message?: import("discord.js").Message, channel?: import("discord.js").TextBasedChannel, silent?: boolean }} [options]
 */
async function punish(target, kind, options = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown punishment "${kind}"`);
  const guild = target.guild;
  const user = target.user;
  const member = target.roles ? target : null;
  const reason = (options.reason ?? "No reason given").slice(0, 400);
  const moderator = options.moderator ?? guild.client.user;
  const channel = options.channel ?? options.message?.channel;
  let duration = options.duration ?? null;

  if (options.message?.deletable) await options.message.delete().catch(() => {});
  if (kind === "delete") return { ok: true, case: null };

  try {
    switch (kind) {
      case "warn":
        break;
      case "timeout":
        duration = Math.min(duration ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        if (!member?.moderatable) throw new Error("I can't time out that member");
        await member.timeout(duration, reason);
        break;
      case "untimeout":
        if (!member?.moderatable) throw new Error("I can't remove that member's timeout");
        await member.timeout(null, reason);
        break;
      case "mute": case "imute": case "rmute":
        await applyRole(member, ROLE_KINDS[kind], true);
        break;
      case "unmute": case "unimute": case "unrmute":
        await applyRole(member, ROLE_KINDS[kind.slice(2)], false);
        break;
      case "jail":
        await jail(member, true);
        break;
      case "unjail":
        await jail(member, false);
        break;
      case "kick":
        if (!member?.kickable) throw new Error("I can't kick that member");
        await member.kick(reason);
        break;
      case "ban": case "softban":
        if (member && !member.bannable) throw new Error("I can't ban that member");
        await guild.members.ban(user, { reason, deleteMessageSeconds: kind === "softban" ? 86400 : 0 });
        if (kind === "softban") await guild.members.unban(user, "Softban").catch(() => {});
        break;
      case "unban":
        await guild.members.unban(user, reason);
        break;
    }
  } catch (err) {
    console.warn(`[punish] ${kind} ${user.tag} in ${guild.name}: ${err.message}`);
    return { ok: false, case: null, error: err.message };
  }

  // Timed role punishments / bans reverse themselves through the scheduler.
  const reversal = REVERSALS[kind];
  if (reversal && kind !== "timeout") {
    if (duration) scheduler.schedule("core:unpunish", Date.now() + duration, { guildId: guild.id, userId: user.id, kind: reversal }, { guildId: guild.id, key: `${guild.id}:${user.id}:${kind}` });
  }
  if (kind.startsWith("un")) scheduler.cancel("core:unpunish", `${guild.id}:${user.id}:${kind.replace(/^un/, "")}`);

  const caseId = openCase(guild.id, user.id, moderator.id, kind, reason, duration);
  const vars = {
    moderator: `<@${moderator.id}>`, "moderator.name": moderator.username, reason,
    duration: duration ? formatDuration(duration) : "permanent", case: caseId, punishment: kind,
  };
  if (!options.silent) await sendInvoke(guild, user, kind, vars, channel);

  await logAction(guild, "punishment", {
    title: `Case #${caseId} • ${kind}`,
    colour: COLOURS[kind],
    user,
    fields: [
      { name: "Member", value: `<@${user.id}>` },
      { name: "Moderator", value: `<@${moderator.id}>` },
      ...(duration ? [{ name: "Duration", value: formatDuration(duration) }] : []),
      { name: "Reason", value: reason, inline: false },
    ],
  });
  return { ok: true, case: caseId };
}

scheduler.define("core:unpunish", async (job, client) => {
  const { guildId, userId, kind } = job.payload;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  if (kind === "unban") {
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) await punish({ guild, user }, "unban", { reason: "Temporary ban expired" });
    return;
  }
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) await punish(member, kind, { reason: "Punishment expired" });
});

module.exports = { punish, KINDS, invokeScript };
