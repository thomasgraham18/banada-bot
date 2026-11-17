/**
 * Permission guard. Handlers declare a `gate` (the strings used in the guide's
 * tables) and the router calls check() before running them.
 *
 * Discord's default_member_permissions applies to a whole top-level command,
 * and Bleed mixes public and admin subcommands, so the real check is here.
 *
 * Fake permissions (/access fakepermissions) count as real permissions for
 * this bot's checks only; they never grant "Server Owner".
 */
const { PermissionFlagsBits } = require("discord.js");
const db = require("./db");
const { guildCache } = require("./cache");
const { UserError } = require("./errors");
const levels = require("./levels");

/** Bleed's paid tier. The user chose: everyone counts as premium. */
const isPremium = (/* user, guild */) => true;

const P = PermissionFlagsBits;

// Gate string -> Discord permission flags (all required).
const PERMISSION_GATES = {
  "Manage Guild": [P.ManageGuild],
  "Manage Channels": [P.ManageChannels],
  "Manage Messages": [P.ManageMessages],
  "Manage Nicknames": [P.ManageNicknames],
  "Manage Webhooks": [P.ManageWebhooks],
  "Manage Expressions": [P.ManageGuildExpressions],
  "Manage Roles": [P.ManageRoles],
  "Moderate Members": [P.ModerateMembers],
  "Ban Members": [P.BanMembers],
  "Kick Members": [P.KickMembers],
  Administrator: [P.Administrator],
  "Attach Files": [P.AttachFiles],
  "Manage Guild & Roles": [P.ManageGuild, P.ManageRoles],
  "Manage Channels & Roles": [P.ManageChannels, P.ManageRoles],
  "Manage Channels & Manage Guild": [P.ManageChannels, P.ManageGuild],
};

/** Permissions that can be granted as fake permissions (Administrator excluded). */
const FAKEABLE = {
  manage_guild: "ManageGuild",
  manage_channels: "ManageChannels",
  manage_roles: "ManageRoles",
  manage_messages: "ManageMessages",
  manage_nicknames: "ManageNicknames",
  manage_webhooks: "ManageWebhooks",
  manage_expressions: "ManageGuildExpressions",
  kick_members: "KickMembers",
  ban_members: "BanMembers",
  moderate_members: "ModerateMembers",
};

/** Permissions that make a role "dangerous" to hand out automatically. */
const DANGEROUS = [
  P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.ManageWebhooks,
  P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages, P.MentionEveryone,
  P.ManageGuildExpressions, P.ManageNicknames,
];

// guildId -> Map(roleId -> Set(permissionName)); and guildId -> Set(staff roleId)
const fakeCache = guildCache((guildId) => {
  const map = new Map();
  for (const row of db.all("SELECT role_id, permission FROM fake_permissions WHERE guild_id = ?", guildId)) {
    if (!map.has(row.role_id)) map.set(row.role_id, new Set());
    map.get(row.role_id).add(row.permission);
  }
  return map;
});
const staffCache = guildCache(
  (guildId) => new Set(db.all("SELECT role_id FROM staff_roles WHERE guild_id = ?", guildId).map((r) => r.role_id))
);

const isOwner = (member) => member?.guild?.ownerId === member?.id;
const isAdmin = (member) => isOwner(member) || Boolean(member?.permissions?.has(P.Administrator));

/** Real permission, or a fake one from any of the member's roles. */
function hasPermission(member, flag) {
  if (!member) return false;
  if (isOwner(member) || member.permissions.has(flag)) return true;
  // Moderators/admins assigned in the web panel (core/levels.js).
  if (levels.levelGrants(member, flag)) return true;
  const name = Object.keys(P).find((k) => P[k] === flag);
  const fake = fakeCache.get(member.guild.id);
  if (!fake.size) return false;
  for (const roleId of member.roles.cache.keys()) {
    const perms = fake.get(roleId);
    if (perms && (perms.has(name) || perms.has("Administrator"))) return true;
  }
  return false;
}

const isStaff = (member) =>
  hasPermission(member, P.ManageGuild) ||
  levels.assignedLevel(member) >= levels.MOD ||
  [...staffCache.get(member.guild.id)].some((id) => member.roles.cache.has(id));

/**
 * Returns null when `member` passes `gate`, otherwise the reason (a string).
 * `gate` may be a string, an array of strings (all required) or undefined.
 */
function check(member, gate) {
  if (!gate) return null;
  if (Array.isArray(gate)) {
    for (const g of gate) {
      const reason = check(member, g);
      if (reason) return reason;
    }
    return null;
  }

  if (gate === "Server Owner")
    return isOwner(member) ? null : "Only the server owner can use this.";
  if (gate === "Staff Only")
    return isStaff(member) ? null : "Only staff can use this (see `/settings staff`).";
  if (gate === "Booster Only")
    return member.premiumSince || isOwner(member) ? null : "Only server boosters can use this.";
  if (gate === "Tier 2 Only")
    return isPremium(member.user, member.guild) ? null : "This is a premium feature.";

  const flags = PERMISSION_GATES[gate];
  if (!flags) throw new Error(`Unknown permission gate "${gate}"`);
  const missing = flags.filter((f) => !hasPermission(member, f));
  return missing.length ? `You need the **${gate}** permission to use this.` : null;
}

/** Throws a UserError unless the member passes the gate. */
function assert(member, gate) {
  const reason = check(member, gate);
  if (reason) throw new UserError(reason);
}

/**
 * Throws unless both the bot and the member can manage `role`:
 * not @everyone, not managed, below the bot's top role and the member's top
 * role (owner exempt), and not dangerous unless the member is an admin.
 */
function assertManageableRole(member, role, { allowDangerous = false } = {}) {
  const guild = member.guild;
  const me = guild.members.me;
  if (!role) throw new UserError("That role doesn't exist.");
  if (role.id === guild.id) throw new UserError("I can't use the @everyone role for that.");
  if (role.managed) throw new UserError(`${role} is managed by an integration or boosting and can't be assigned.`);
  if (!me.permissions.has(P.ManageRoles)) throw new UserError("I need the **Manage Roles** permission.");
  if (me.roles.highest.comparePositionTo(role) <= 0)
    throw new UserError(`${role} is above or equal to my highest role. Move my role above it.`);
  if (!isOwner(member) && member.roles.highest.comparePositionTo(role) <= 0)
    throw new UserError(`${role} is above or equal to your highest role.`);
  if (!allowDangerous && !isAdmin(member) && DANGEROUS.some((p) => role.permissions.has(p)))
    throw new UserError(`${role} has moderator permissions; only an administrator can use it here.`);
}

/** True when the bot can add/remove `role` (no member check). */
const botCanManageRole = (guild, role) =>
  Boolean(role && !role.managed && role.id !== guild.id && guild.members.me?.permissions.has(P.ManageRoles) &&
    guild.members.me.roles.highest.comparePositionTo(role) > 0);

/** Throws a UserError naming the bot permissions missing in `channel` (or guild-wide). */
function assertBotPermissions(guildOrChannel, flags, where) {
  const guild = guildOrChannel.guild ?? guildOrChannel;
  const perms = guildOrChannel.guild ? guildOrChannel.permissionsFor(guild.members.me) : guild.members.me.permissions;
  const names = Object.entries(P).filter(([, v]) => flags.includes(v) && !perms?.has(v)).map(([k]) => k.replace(/([a-z])([A-Z])/g, "$1 $2"));
  if (names.length)
    throw new UserError(`I'm missing **${names.join(", ")}**${where ? ` in ${where}` : guildOrChannel.guild ? ` in ${guildOrChannel}` : ""}.`);
}

/**
 * May `member` run the command at `path` ("levels rank") whose gate is `gate`?
 * Returns a reason string, or null when allowed.
 *
 * 1. The member's access level must reach the command's required level
 *    (core/levels.js: default from the gate, or the server's override).
 * 2. Without an override, the gate itself is also checked (it's finer than
 *    the level, e.g. "Manage Guild & Roles").
 *    With an override, the server chose who may run it, so the level alone
 *    decides, except "Server Owner" gates, which always apply.
 */
function authorize(member, path, gate) {
  if (!member?.guild) return null;
  const { level, overridden } = levels.required(member.guild.id, path, levels.gateLevel(gate, PERMISSION_GATES));
  if (levels.memberLevel(member) < level) return levels.tooLow(level);
  const parts = Array.isArray(gate) ? gate : [gate];
  if (overridden && !parts.includes("Server Owner")) return null;
  return check(member, gate);
}

/** For classic { data, execute } commands: the level comes from their Discord default permissions. */
function authorizeClassic(member, path, defaultPermissions) {
  if (!member?.guild) return null;
  const { level } = levels.required(member.guild.id, path, levels.bitsLevel(defaultPermissions));
  return levels.memberLevel(member) < level ? levels.tooLow(level) : null;
}

module.exports = {
  authorize,
  authorizeClassic,
  levels,
  check,
  assert,
  hasPermission,
  isOwner,
  isAdmin,
  isStaff,
  isPremium,
  assertManageableRole,
  botCanManageRole,
  assertBotPermissions,
  FAKEABLE,
  DANGEROUS,
  PERMISSION_GATES,
  invalidateFake: (guildId) => fakeCache.invalidate(guildId),
  invalidateStaff: (guildId) => staffCache.invalidate(guildId),
};
