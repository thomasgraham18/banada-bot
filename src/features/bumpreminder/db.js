/**
 * Storage for /bumpreminder: one row per guild.
 *
 * Script columns use NULL = "use the default message". The thank-you can also
 * be switched off entirely with an empty string ("" = none), which is what
 * `/bumpreminder clear thankyou` does. The reminder itself always has a
 * message, so clearing it just falls back to the default.
 */
const { db, guildCache } = require("../../core");

db.migrate(
  "bumpreminder_001_init",
  `CREATE TABLE IF NOT EXISTS bumpreminder (
    guild_id        TEXT PRIMARY KEY,
    enabled         INTEGER NOT NULL DEFAULT 0,
    channel_id      TEXT,
    reminder_script TEXT,
    pingable        INTEGER NOT NULL DEFAULT 0,
    thankyou_script TEXT,
    autolock        INTEGER NOT NULL DEFAULT 0,
    autoclean       INTEGER NOT NULL DEFAULT 0,
    next_bump_at    INTEGER,
    last_bumper_id  TEXT
  );`
);

/** Columns update() may write (guards the dynamic SQL below). */
const COLUMNS = ["enabled", "channel_id", "reminder_script", "pingable", "thankyou_script", "autolock", "autoclean", "next_bump_at", "last_bumper_id"];

/** Settings with defaults, so callers never have to null-check the row. */
const DEFAULTS = {
  enabled: false,
  channel_id: null,
  reminder_script: null,
  pingable: false,
  thankyou_script: null,
  autolock: false,
  autoclean: false,
  next_bump_at: null,
  last_bumper_id: null,
};

function load(guildId) {
  const row = db.get("SELECT * FROM bumpreminder WHERE guild_id = ?", guildId);
  if (!row) return { guild_id: guildId, ...DEFAULTS };
  // SQLite stores booleans as 0/1; turn them back into booleans.
  return { ...row, enabled: !!row.enabled, pingable: !!row.pingable, autolock: !!row.autolock, autoclean: !!row.autoclean };
}

/** Read through this on hot paths (the messageCreate listener). */
const cache = guildCache(load);

const get = (guildId) => cache.get(guildId);

/** Upserts the given columns for a guild and refreshes the cache. */
function update(guildId, fields) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!COLUMNS.includes(k)) throw new Error(`bumpreminder: unknown column ${k}`);
  db.transaction(() => {
    db.run("INSERT OR IGNORE INTO bumpreminder (guild_id) VALUES (?)", guildId);
    if (keys.length)
      db.run(`UPDATE bumpreminder SET ${keys.map((k) => `${k} = :${k}`).join(", ")} WHERE guild_id = :guild_id`, { ...fields, guild_id: guildId });
  });
  cache.invalidate(guildId);
  return get(guildId);
}

module.exports = { get, update, load, cache, DEFAULTS };
