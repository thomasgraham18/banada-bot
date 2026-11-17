/**
 * Levels storage: migrations, the cached guild settings and member queries.
 *
 * Tables (all prefixed "levels_"):
 *   levels_config   one row per guild: on/off, rate, stacking, level-up message
 *   levels_members  XP per member (+ cached level and message opt-out)
 *   levels_roles    one role per level
 *   levels_ignores  channels / roles that earn no XP
 *
 * `xp` is the source of truth; `level` is always levelForXp(xp) and is kept
 * in the row so other packages (giveaways, leaderboards) can read it cheaply.
 */
const { db, guildCache } = require("../../core");
const { levelForXp, clampMultiplier, MAX_XP } = require("./formula");

db.migrate(
  "levels_001_init",
  `
  CREATE TABLE levels_config (
    guild_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    multiplier REAL NOT NULL DEFAULT 1,
    stack_roles INTEGER NOT NULL DEFAULT 1,
    message_mode TEXT NOT NULL DEFAULT 'here' CHECK (message_mode IN ('here', 'channel', 'dm', 'off')),
    message_channel_id TEXT,
    script TEXT,
    leaderboard_title TEXT
  );
  CREATE TABLE levels_members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    last_xp_at INTEGER,
    messages_opt_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX levels_members_by_xp ON levels_members (guild_id, xp DESC);
  CREATE TABLE levels_roles (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, level)
  );
  CREATE TABLE levels_ignores (
    guild_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('role', 'channel')),
    PRIMARY KEY (guild_id, target_id)
  );
  `
);

const DEFAULT_SCRIPT = "GG {user.mention}, you reached **level {level}**!";

// ---------------------------------------------------------------- settings (cached)

/**
 * Everything the messageCreate hot path needs, loaded once per guild and
 * invalidated after every write below.
 */
const settings = guildCache((guildId) => {
  const row = db.get("SELECT * FROM levels_config WHERE guild_id = ?", guildId) ?? {};
  const ignores = db.all("SELECT target_id, kind FROM levels_ignores WHERE guild_id = ?", guildId);
  return {
    enabled: Boolean(row.enabled),
    multiplier: row.multiplier ?? 1,
    stackRoles: row.stack_roles == null ? true : Boolean(row.stack_roles),
    messageMode: row.message_mode ?? "here",
    messageChannelId: row.message_channel_id ?? null,
    script: row.script ?? DEFAULT_SCRIPT,
    customScript: row.script != null,
    leaderboardTitle: row.leaderboard_title ?? null,
    roles: db
      .all("SELECT level, role_id FROM levels_roles WHERE guild_id = ? ORDER BY level", guildId)
      .map((r) => ({ level: r.level, roleId: r.role_id })),
    ignoredChannels: new Set(ignores.filter((i) => i.kind === "channel").map((i) => i.target_id)),
    ignoredRoles: new Set(ignores.filter((i) => i.kind === "role").map((i) => i.target_id)),
  };
});

/** Columns updateConfig() may write (names are interpolated, so whitelist them). */
const CONFIG_COLUMNS = new Set(["enabled", "multiplier", "stack_roles", "message_mode", "message_channel_id", "script", "leaderboard_title"]);

/** Upserts some levels_config columns: updateConfig(guildId, { enabled: true }). */
function updateConfig(guildId, patch) {
  const columns = Object.keys(patch);
  for (const c of columns) if (!CONFIG_COLUMNS.has(c)) throw new Error(`levels: unknown config column ${c}`);
  if (patch.multiplier !== undefined) patch = { ...patch, multiplier: clampMultiplier(patch.multiplier) };
  db.run(
    `INSERT INTO levels_config (guild_id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})
     ON CONFLICT (guild_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    guildId,
    ...columns.map((c) => patch[c])
  );
  settings.invalidate(guildId);
}

// ---------------------------------------------------------------- level roles

function setLevelRole(guildId, level, roleId) {
  db.run(
    "INSERT INTO levels_roles (guild_id, level, role_id) VALUES (?, ?, ?) ON CONFLICT (guild_id, level) DO UPDATE SET role_id = excluded.role_id",
    guildId, level, roleId
  );
  settings.invalidate(guildId);
}

function removeLevelRole(guildId, level) {
  const { changes } = db.run("DELETE FROM levels_roles WHERE guild_id = ? AND level = ?", guildId, level);
  settings.invalidate(guildId);
  return changes > 0;
}

/** Drops level-role rows for a deleted role. Returns how many were removed. */
function forgetRole(guildId, roleId) {
  const { changes } = db.run("DELETE FROM levels_roles WHERE guild_id = ? AND role_id = ?", guildId, roleId);
  db.run("DELETE FROM levels_ignores WHERE guild_id = ? AND target_id = ?", guildId, roleId);
  settings.invalidate(guildId);
  return changes;
}

// ---------------------------------------------------------------- ignores

/** Adds the target if it's not ignored, removes it if it is. Returns true when now ignored. */
function toggleIgnore(guildId, targetId, kind) {
  const { changes } = db.run("DELETE FROM levels_ignores WHERE guild_id = ? AND target_id = ?", guildId, targetId);
  if (!changes) db.run("INSERT INTO levels_ignores (guild_id, target_id, kind) VALUES (?, ?, ?)", guildId, targetId, kind);
  settings.invalidate(guildId);
  return !changes;
}

// ---------------------------------------------------------------- members

/**
 * The hot-path write: ONE upsert per awarded message. Returns the row after
 * the update (new total xp, the level stored BEFORE this message, opt-out).
 */
const awardXp = (guildId, userId, gain, now = Date.now()) =>
  db.get(
    `INSERT INTO levels_members (guild_id, user_id, xp, level, last_xp_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = MIN(xp + excluded.xp, ${MAX_XP}), last_xp_at = excluded.last_xp_at
     RETURNING xp, level, messages_opt_out`,
    guildId, userId, gain, now
  );

/** Stores a new level after awardXp() crossed a threshold (only on level-up). */
const storeLevel = (guildId, userId, level) =>
  db.run("UPDATE levels_members SET level = ? WHERE guild_id = ? AND user_id = ?", level, guildId, userId);

/** Sets total XP (and the matching level). Returns { xp, level }. */
function setXp(guildId, userId, xp) {
  const total = Math.max(0, Math.min(MAX_XP, Math.floor(xp)));
  const level = levelForXp(total);
  db.run(
    `INSERT INTO levels_members (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level`,
    guildId, userId, total, level
  );
  return { xp: total, level };
}

function setOptOut(guildId, userId, optOut) {
  db.run(
    `INSERT INTO levels_members (guild_id, user_id, messages_opt_out) VALUES (?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET messages_opt_out = excluded.messages_opt_out`,
    guildId, userId, optOut
  );
}

const getMember = (guildId, userId) =>
  db.get("SELECT xp, level, messages_opt_out FROM levels_members WHERE guild_id = ? AND user_id = ?", guildId, userId);

/** 1-based server rank for someone with `xp` (ties share a rank). */
const rankOf = (guildId, xp) =>
  db.get("SELECT COUNT(*) AS n FROM levels_members WHERE guild_id = ? AND xp > ?", guildId, xp).n + 1;

/** How many members have any XP. */
const rankedCount = (guildId) => db.get("SELECT COUNT(*) AS n FROM levels_members WHERE guild_id = ? AND xp > 0", guildId).n;

/** user_id -> level for every member with XP (used by /levels sync). */
const levelsByUser = (guildId) =>
  new Map(db.all("SELECT user_id, level FROM levels_members WHERE guild_id = ? AND xp > 0", guildId).map((r) => [r.user_id, r.level]));

const allUserIds = (guildId) => db.all("SELECT user_id FROM levels_members WHERE guild_id = ?", guildId).map((r) => r.user_id);

/** Deletes the given members' rows. Returns how many were removed. */
function deleteMembers(guildId, userIds) {
  return db.transaction(() => {
    let n = 0;
    for (const id of userIds) n += db.run("DELETE FROM levels_members WHERE guild_id = ? AND user_id = ?", guildId, id).changes;
    return n;
  });
}

/** Wipes XP for the whole guild but keeps each member's message opt-out. */
function resetGuild(guildId) {
  return db.transaction(() => {
    const affected = rankedCount(guildId);
    db.run("DELETE FROM levels_members WHERE guild_id = ? AND messages_opt_out = 0", guildId);
    db.run("UPDATE levels_members SET xp = 0, level = 0, last_xp_at = NULL WHERE guild_id = ?", guildId);
    return affected;
  });
}

// ---------------------------------------------------------------- public api (other packages)

/** Level of a member, 0 when unknown. Synchronous. */
const getLevel = (guildId, userId) => getMember(guildId, userId)?.level ?? 0;

/** Total XP of a member, 0 when unknown. Synchronous. */
const getXp = (guildId, userId) => getMember(guildId, userId)?.xp ?? 0;

/** Members sorted by XP (highest first): [{ userId, xp, level }]. */
function getLeaderboard(guildId, { limit = 10, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(1000, Math.floor(limit) || 10));
  const off = Math.max(0, Math.floor(offset) || 0);
  return db
    .all(
      "SELECT user_id, xp, level FROM levels_members WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id LIMIT ? OFFSET ?",
      guildId, lim, off
    )
    .map((r) => ({ userId: r.user_id, xp: r.xp, level: r.level }));
}

module.exports = {
  DEFAULT_SCRIPT,
  settings,
  updateConfig,
  setLevelRole,
  removeLevelRole,
  forgetRole,
  toggleIgnore,
  awardXp,
  storeLevel,
  setXp,
  setOptOut,
  getMember,
  rankOf,
  rankedCount,
  levelsByUser,
  allUserIds,
  deleteMembers,
  resetGuild,
  getLevel,
  getXp,
  getLeaderboard,
};
