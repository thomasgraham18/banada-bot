/**
 * Access levels: who may run which command, per server, managed in the web
 * panel (Server → Permissions).
 *
 *   0 member     everyone
 *   1 mod        panel mod roles/users, staff roles (/settings staff), or
 *                anyone with a moderation permission (Manage Messages, Kick...)
 *   2 admin      panel admin roles/users, or Administrator / Manage Server
 *   3 owner      the server owner, or the bot owner (OWNER_ID)
 *
 * Every command path ("levels rank") has a required level. By default it
 * comes from the command's permission gate (see gateLevel); a server can
 * override any command or subcommand. Overrides are looked up most specific
 * first: "settings staff set" -> "settings staff" -> "settings".
 *
 * This module must not require guard.js (guard requires it).
 */
const { PermissionFlagsBits: P } = require("discord.js");
const db = require("./db");
const { guildCache } = require("./cache");

const LEVELS = ["member", "mod", "admin", "owner"];
const LABELS = { member: "Members", mod: "Moderators", admin: "Admins", owner: "the server owner" };
const MEMBER = 0, MOD = 1, ADMIN = 2, OWNER = 3;

db.migrate(
  "core_002_levels",
  `
  -- Panel-assigned moderators/admins. kind = 'role' | 'user'.
  CREATE TABLE access_levels (
    guild_id  TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('role', 'user')),
    level     TEXT NOT NULL CHECK (level IN ('mod', 'admin')),
    PRIMARY KEY (guild_id, target_id)
  );
  -- Per-server overrides of a command's required level.
  CREATE TABLE command_levels (
    guild_id TEXT NOT NULL,
    command  TEXT NOT NULL,             -- "levels" or "levels rank"
    level    TEXT NOT NULL CHECK (level IN ('member', 'mod', 'admin', 'owner')),
    PRIMARY KEY (guild_id, command)
  );
`
);

// Bot owner from config.json (optional).
let botOwnerId = null;
try {
  botOwnerId = require("../config.json").OWNER_ID ?? null;
} catch {
  /* no config (tests) */
}

const cache = guildCache((guildId) => {
  const s = { assigned: new Map(), staff: new Set(), commands: new Map() };
  for (const r of db.all("SELECT target_id, level FROM access_levels WHERE guild_id = ?", guildId))
    s.assigned.set(r.target_id, LEVELS.indexOf(r.level));
  for (const r of db.all("SELECT role_id FROM staff_roles WHERE guild_id = ?", guildId)) s.staff.add(r.role_id);
  for (const r of db.all("SELECT command, level FROM command_levels WHERE guild_id = ?", guildId))
    s.commands.set(r.command, LEVELS.indexOf(r.level));
  return s;
});

// Discord permissions -> level they imply / level that grants them.
const ADMIN_FLAGS = [P.Administrator, P.ManageGuild];
const MOD_FLAGS = [P.ManageMessages, P.ManageChannels, P.ModerateMembers, P.KickMembers, P.BanMembers, P.ManageNicknames, P.ManageRoles];
// Permissions a panel moderator is treated as having for the bot's own checks.
// Anything else (Manage Server, Manage Roles, Ban...) needs admin.
const MOD_GRANTS = new Set([P.ManageMessages, P.ManageChannels, P.ManageNicknames, P.ModerateMembers, P.KickMembers, P.ManageGuildExpressions, P.ManageWebhooks]);

const isOwner = (member) => member?.id === member?.guild?.ownerId || (botOwnerId && member?.id === botOwnerId);

/**
 * The level the panel / staff list explicitly gives a member (owner counts).
 * Used to grant permissions inside the bot. It never derives from Discord
 * permissions, so Manage Messages alone doesn't unlock Manage Channels checks.
 */
function assignedLevel(member) {
  if (!member?.guild) return MEMBER;
  if (isOwner(member)) return OWNER;
  const s = cache.get(member.guild.id);
  let level = s.assigned.get(member.id) ?? MEMBER;
  for (const roleId of member.roles?.cache?.keys?.() ?? []) {
    if (s.assigned.has(roleId)) level = Math.max(level, s.assigned.get(roleId));
    else if (s.staff.has(roleId)) level = Math.max(level, MOD);
  }
  return level;
}

/** The member's effective level: assigned level, or what their Discord permissions imply. */
function memberLevel(member) {
  let level = assignedLevel(member);
  const perms = member?.permissions;
  if (level < ADMIN && perms && ADMIN_FLAGS.some((f) => perms.has(f))) level = ADMIN;
  if (level < MOD && perms && MOD_FLAGS.some((f) => perms.has(f))) level = MOD;
  return level;
}

/** True when the member's assigned level grants this Discord permission inside the bot. */
function levelGrants(member, flag) {
  const level = assignedLevel(member);
  if (level >= ADMIN) return flag !== P.Administrator || level >= OWNER;
  return level >= MOD && MOD_GRANTS.has(flag);
}

// ---------------------------------------------------------------- defaults

/** Default level for a router permission gate string (see guard.js PERMISSION_GATES). */
function gateLevel(gate, permissionGates) {
  const parts = Array.isArray(gate) ? gate : [gate];
  let level = MEMBER;
  for (const g of parts) {
    if (!g || ["Booster Only", "Tier 2 Only", "Attach Files"].includes(g)) continue;
    if (g === "Server Owner") return OWNER;
    if (g === "Staff Only") { level = Math.max(level, MOD); continue; }
    const flags = permissionGates[g] ?? [];
    for (const f of flags) level = Math.max(level, MOD_GRANTS.has(f) ? MOD : ADMIN);
  }
  return level;
}

/** Default level for a classic command from its Discord default_member_permissions. */
function bitsLevel(bits) {
  if (!bits || bits === "0") return MEMBER;
  const n = BigInt(bits);
  if (n & P.Administrator) return ADMIN;
  for (const f of ADMIN_FLAGS) if (n & f) return ADMIN;
  return [...MOD_GRANTS].some((f) => n & f) ? MOD : ADMIN;
}

/**
 * Required level for a command path in a guild.
 * @returns {{ level: number, overridden: boolean }}
 */
function required(guildId, path, defaultLevel) {
  const overrides = cache.get(guildId).commands;
  if (overrides.size) {
    const words = path.split(" ");
    for (let n = words.length; n > 0; n--) {
      const key = words.slice(0, n).join(" ");
      if (overrides.has(key)) return { level: overrides.get(key), overridden: true };
    }
  }
  return { level: defaultLevel, overridden: false };
}

const tooLow = (level) => `This command is for ${LABELS[LEVELS[level]]}.`;

// ---------------------------------------------------------------- writes (web panel)

const levels = {
  LEVELS, LABELS, MEMBER, MOD, ADMIN, OWNER,
  isOwner, assignedLevel, memberLevel, levelGrants, gateLevel, bitsLevel, required, tooLow,
  name: (level) => LEVELS[level],

  setCommandLevel(guildId, command, level) {
    if (level == null || level === "") db.run("DELETE FROM command_levels WHERE guild_id = ? AND command = ?", guildId, command);
    else {
      if (!LEVELS.includes(level)) throw new Error(`bad level ${level}`);
      db.run(
        `INSERT INTO command_levels (guild_id, command, level) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, command) DO UPDATE SET level = excluded.level`,
        guildId, command, level
      );
    }
    cache.invalidate(guildId);
  },
  commandOverrides: (guildId) => Object.fromEntries([...cache.get(guildId).commands].map(([k, v]) => [k, LEVELS[v]])),
  invalidate: (guildId) => cache.invalidate(guildId),
};

module.exports = levels;
