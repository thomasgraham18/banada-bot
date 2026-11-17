/**
 * Storage for /boosterrole and /badge.
 *
 * Tables (all prefixed with the package name, "boosterrole"):
 *   boosterrole_roles          one custom role per booster (owner -> role)
 *   boosterrole_shares         members an owner shared their role with
 *   boosterrole_filter         words that booster role names may not contain
 *   boosterrole_settings       award role, share limits, server-wide role limit
 *   boosterrole_badge_settings guild tag rewards: on/off, award channel, award message
 *   boosterrole_badge_roles    roles given to members wearing the guild tag
 *   boosterrole_badge_members  members we have seen wearing the tag (so the award
 *                              message is posted once per adoption, not on every event)
 *
 * The base role is NOT stored here: it is the shared guild_config key
 * config.KEYS.BASE_ROLE (also set by /settings baserole), so there is one source of truth.
 *
 * Listeners read through the two guildCaches at the bottom; every write calls
 * invalidate() for that guild.
 */
const { db, guildCache } = require("../../core");

db.migrate(
  "boosterrole_001_init",
  `
  CREATE TABLE boosterrole_roles (
    guild_id   TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, owner_id),
    UNIQUE (guild_id, role_id)
  );
  CREATE TABLE boosterrole_shares (
    guild_id  TEXT NOT NULL,
    role_id   TEXT NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id, member_id)
  );
  CREATE INDEX boosterrole_shares_member ON boosterrole_shares (guild_id, member_id);
  CREATE TABLE boosterrole_filter (
    guild_id TEXT NOT NULL,
    word     TEXT NOT NULL,
    PRIMARY KEY (guild_id, word)
  );
  CREATE TABLE boosterrole_settings (
    guild_id      TEXT PRIMARY KEY,
    award_role_id TEXT,
    share_limit   INTEGER,   -- max booster roles one member can be in (NULL = no limit)
    share_max     INTEGER,   -- max members shared into one role (NULL = no limit)
    role_limit    INTEGER    -- max booster roles in the server (NULL = no limit)
  );
  CREATE TABLE boosterrole_badge_settings (
    guild_id   TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 0,
    channel_id TEXT,
    script     TEXT
  );
  CREATE TABLE boosterrole_badge_roles (
    guild_id TEXT NOT NULL,
    role_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );
  CREATE TABLE boosterrole_badge_members (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    since    INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  `
);

// ---------------------------------------------------------------- caches (listener hot paths)

/** Booster roles of a guild: byOwner, byRole, award role. */
const boosterCache = guildCache((guildId) => {
  const byOwner = new Map();
  const byRole = new Map();
  for (const row of db.all("SELECT owner_id, role_id FROM boosterrole_roles WHERE guild_id = ?", guildId)) {
    byOwner.set(row.owner_id, row.role_id);
    byRole.set(row.role_id, row.owner_id);
  }
  const settings = db.get("SELECT award_role_id FROM boosterrole_settings WHERE guild_id = ?", guildId);
  return { byOwner, byRole, awardRoleId: settings?.award_role_id ?? null };
});

/** Guild tag reward config + who currently has the reward. */
const badgeCache = guildCache((guildId) => {
  const s = db.get("SELECT enabled, channel_id, script FROM boosterrole_badge_settings WHERE guild_id = ?", guildId);
  return {
    enabled: Boolean(s?.enabled),
    channelId: s?.channel_id ?? null,
    script: s?.script ?? null,
    roleIds: db.all("SELECT role_id FROM boosterrole_badge_roles WHERE guild_id = ?", guildId).map((r) => r.role_id),
    members: new Set(db.all("SELECT user_id FROM boosterrole_badge_members WHERE guild_id = ?", guildId).map((r) => r.user_id)),
  };
});

// ---------------------------------------------------------------- booster roles

const roles = {
  byOwner: (guildId, ownerId) => boosterCache.get(guildId).byOwner.get(ownerId) ?? null,
  ownerOf: (guildId, roleId) => boosterCache.get(guildId).byRole.get(roleId) ?? null,
  count: (guildId) => boosterCache.get(guildId).byOwner.size,
  all: (guildId) => db.all("SELECT owner_id, role_id, created_at FROM boosterrole_roles WHERE guild_id = ? ORDER BY created_at", guildId),

  /** Registers (or replaces) the owner's booster role. */
  set(guildId, ownerId, roleId) {
    db.transaction(() => {
      // A role belongs to at most one owner: drop any previous link to it.
      db.run("DELETE FROM boosterrole_roles WHERE guild_id = ? AND role_id = ? AND owner_id != ?", guildId, roleId, ownerId);
      db.run(
        `INSERT INTO boosterrole_roles (guild_id, owner_id, role_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, owner_id) DO UPDATE SET role_id = excluded.role_id`,
        guildId, ownerId, roleId, Date.now()
      );
    });
    boosterCache.invalidate(guildId);
  },

  /** Forgets a booster role and everyone it was shared with. */
  removeRole(guildId, roleId) {
    db.transaction(() => {
      db.run("DELETE FROM boosterrole_roles WHERE guild_id = ? AND role_id = ?", guildId, roleId);
      db.run("DELETE FROM boosterrole_shares WHERE guild_id = ? AND role_id = ?", guildId, roleId);
    });
    boosterCache.invalidate(guildId);
  },
};

// ---------------------------------------------------------------- shares

const shares = {
  members: (guildId, roleId) => db.all("SELECT member_id FROM boosterrole_shares WHERE guild_id = ? AND role_id = ?", guildId, roleId).map((r) => r.member_id),
  rolesOf: (guildId, memberId) => db.all("SELECT role_id FROM boosterrole_shares WHERE guild_id = ? AND member_id = ?", guildId, memberId).map((r) => r.role_id),
  has: (guildId, roleId, memberId) => Boolean(db.get("SELECT 1 FROM boosterrole_shares WHERE guild_id = ? AND role_id = ? AND member_id = ?", guildId, roleId, memberId)),
  add: (guildId, roleId, memberId) => db.run("INSERT OR IGNORE INTO boosterrole_shares (guild_id, role_id, member_id) VALUES (?, ?, ?)", guildId, roleId, memberId).changes > 0,
  remove: (guildId, roleId, memberId) => db.run("DELETE FROM boosterrole_shares WHERE guild_id = ? AND role_id = ? AND member_id = ?", guildId, roleId, memberId).changes > 0,
  removeMember: (guildId, memberId) => db.run("DELETE FROM boosterrole_shares WHERE guild_id = ? AND member_id = ?", guildId, memberId).changes,
};

// ---------------------------------------------------------------- filter words

const filter = {
  list: (guildId) => db.all("SELECT word FROM boosterrole_filter WHERE guild_id = ? ORDER BY word", guildId).map((r) => r.word),
  add: (guildId, word) => db.run("INSERT OR IGNORE INTO boosterrole_filter (guild_id, word) VALUES (?, ?)", guildId, word).changes > 0,
  remove: (guildId, word) => db.run("DELETE FROM boosterrole_filter WHERE guild_id = ? AND word = ?", guildId, word).changes > 0,
};

// ---------------------------------------------------------------- settings

const SETTING_COLUMNS = new Set(["award_role_id", "share_limit", "share_max", "role_limit"]);

const settings = {
  get: (guildId) =>
    db.get("SELECT award_role_id, share_limit, share_max, role_limit FROM boosterrole_settings WHERE guild_id = ?", guildId) ??
    { award_role_id: null, share_limit: null, share_max: null, role_limit: null },

  set(guildId, column, value) {
    if (!SETTING_COLUMNS.has(column)) throw new Error(`unknown boosterrole setting ${column}`);
    // Column names can't be bound as parameters; the whitelist above keeps this safe.
    db.run(
      `INSERT INTO boosterrole_settings (guild_id, ${column}) VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET ${column} = excluded.${column}`,
      guildId, value
    );
    boosterCache.invalidate(guildId);
  },
};

// ---------------------------------------------------------------- badge

const badge = {
  get: (guildId) => badgeCache.get(guildId),
  enabledGuilds: () => db.all("SELECT guild_id FROM boosterrole_badge_settings WHERE enabled = 1").map((r) => r.guild_id),

  set(guildId, column, value) {
    if (!["enabled", "channel_id", "script"].includes(column)) throw new Error(`unknown badge setting ${column}`);
    db.run(
      `INSERT INTO boosterrole_badge_settings (guild_id, ${column}) VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET ${column} = excluded.${column}`,
      guildId, value
    );
    badgeCache.invalidate(guildId);
  },

  addRole(guildId, roleId) {
    const added = db.run("INSERT OR IGNORE INTO boosterrole_badge_roles (guild_id, role_id) VALUES (?, ?)", guildId, roleId).changes > 0;
    badgeCache.invalidate(guildId);
    return added;
  },
  removeRole(guildId, roleId) {
    const removed = db.run("DELETE FROM boosterrole_badge_roles WHERE guild_id = ? AND role_id = ?", guildId, roleId).changes > 0;
    badgeCache.invalidate(guildId);
    return removed;
  },

  /** Records whether a member currently has the tag reward. Returns true if it changed. */
  setMember(guildId, userId, wearing) {
    const changed = wearing
      ? db.run("INSERT OR IGNORE INTO boosterrole_badge_members (guild_id, user_id, since) VALUES (?, ?, ?)", guildId, userId, Date.now()).changes > 0
      : db.run("DELETE FROM boosterrole_badge_members WHERE guild_id = ? AND user_id = ?", guildId, userId).changes > 0;
    // Update the cached set in place instead of reloading the whole guild.
    const members = badgeCache.get(guildId).members;
    if (wearing) members.add(userId);
    else members.delete(userId);
    return changed;
  },
};

module.exports = { roles, shares, filter, settings, badge, boosterCache, badgeCache };
