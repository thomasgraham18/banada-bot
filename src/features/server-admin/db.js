/**
 * server-admin tables + queries.
 *
 * Most of what /settings, /ignore, /access and /invoke store lives in tables
 * the core owns (guild_config, staff_roles, fake_permissions, ignores,
 * disabled_*, invoke_messages, cases). This package only adds honeypots.
 */
const { db, guildCache, access } = require("../../core");

db.migrate(
  "server_admin_001_init",
  `
  -- /antiraid honeypot: bait channels; anyone (non-staff) who posts gets punished.
  CREATE TABLE server_admin_honeypots (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    punishment TEXT NOT NULL DEFAULT 'ban',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
`
);

// ---------------------------------------------------------------- honeypots

/** guildId -> Map(channelId -> punishment). Read by the messageCreate listener. */
const honeypotCache = guildCache((guildId) => {
  const rows = db.all("SELECT channel_id, punishment FROM server_admin_honeypots WHERE guild_id = ?", guildId);
  return new Map(rows.map((r) => [r.channel_id, r.punishment]));
});

const honeypots = {
  get: (guildId) => honeypotCache.get(guildId),
  add(guildId, channelId, punishment, userId) {
    db.run(
      `INSERT INTO server_admin_honeypots (guild_id, channel_id, punishment, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET punishment = excluded.punishment`,
      guildId, channelId, punishment, userId, Date.now()
    );
    honeypotCache.invalidate(guildId);
  },
  remove(guildId, channelId) {
    const { changes } = db.run("DELETE FROM server_admin_honeypots WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    honeypotCache.invalidate(guildId);
    return changes > 0;
  },
};

// ---------------------------------------------------------------- staff roles
// core owns the table; it caches it in guard, so invalidate after each write.

const staff = {
  list: (guildId) => db.all("SELECT role_id FROM staff_roles WHERE guild_id = ?", guildId).map((r) => r.role_id),
  set(guildId, roleId, enabled) {
    const { changes } = enabled
      ? db.run("INSERT OR IGNORE INTO staff_roles (guild_id, role_id) VALUES (?, ?)", guildId, roleId)
      : db.run("DELETE FROM staff_roles WHERE guild_id = ? AND role_id = ?", guildId, roleId);
    access.invalidate(guildId);
    return changes > 0;
  },
  clear(guildId) {
    const { changes } = db.run("DELETE FROM staff_roles WHERE guild_id = ?", guildId);
    access.invalidate(guildId);
    return changes;
  },
};

// ---------------------------------------------------------------- fake permissions

const fake = {
  /** [{ role_id, permission }] optionally for one role. */
  list: (guildId, roleId) =>
    roleId
      ? db.all("SELECT role_id, permission FROM fake_permissions WHERE guild_id = ? AND role_id = ? ORDER BY permission", guildId, roleId)
      : db.all("SELECT role_id, permission FROM fake_permissions WHERE guild_id = ? ORDER BY role_id, permission", guildId),
  add(guildId, roleId, permissions) {
    let added = 0;
    db.transaction(() => {
      for (const p of permissions)
        added += db.run("INSERT OR IGNORE INTO fake_permissions (guild_id, role_id, permission) VALUES (?, ?, ?)", guildId, roleId, p).changes;
    });
    access.invalidate(guildId);
    return added;
  },
  remove(guildId, roleId, permissions) {
    let removed = 0;
    db.transaction(() => {
      for (const p of permissions)
        removed += db.run("DELETE FROM fake_permissions WHERE guild_id = ? AND role_id = ? AND permission = ?", guildId, roleId, p).changes;
    });
    access.invalidate(guildId);
    return removed;
  },
  reset(guildId) {
    const { changes } = db.run("DELETE FROM fake_permissions WHERE guild_id = ?", guildId);
    access.invalidate(guildId);
    return changes;
  },
};

// ---------------------------------------------------------------- invoke messages
// core/punish.js reads this table directly (no cache), so no invalidation needed.

const invoke = {
  get: (guildId, punishment, target) =>
    db.get("SELECT script FROM invoke_messages WHERE guild_id = ? AND punishment = ? AND target = ?", guildId, punishment, target)?.script ?? null,
  set: (guildId, punishment, target, script) =>
    db.run(
      `INSERT INTO invoke_messages (guild_id, punishment, target, script) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, punishment, target) DO UPDATE SET script = excluded.script`,
      guildId, punishment, target, script
    ),
  clear: (guildId, punishment, target) =>
    db.run("DELETE FROM invoke_messages WHERE guild_id = ? AND punishment = ? AND target = ?", guildId, punishment, target).changes > 0,
  count: (guildId) => db.get("SELECT COUNT(*) AS n FROM invoke_messages WHERE guild_id = ?", guildId).n,
};

// ---------------------------------------------------------------- cases

const cases = {
  count: (guildId) => db.get("SELECT COUNT(*) AS n FROM cases WHERE guild_id = ?", guildId).n,
  reset: (guildId) => db.run("DELETE FROM cases WHERE guild_id = ?", guildId).changes,
};

module.exports = { honeypots, staff, fake, invoke, cases };
