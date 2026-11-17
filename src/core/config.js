/**
 * guild_config: single-valued settings per guild, stored as key -> JSON.
 *
 *   config.get(guildId, "modlog")            // value or undefined
 *   config.get(guildId, "jail_roles", false) // with a fallback
 *   config.set(guildId, "modlog", channelId)
 *   config.remove(guildId, "modlog")
 *
 * Reads are served from memory (whole guild loaded on first use).
 *
 * KEYS is the shared vocabulary between packages: if your package reads or
 * writes a key another package owns, use the constant from here.
 */
const db = require("./db");
const { guildCache } = require("./cache");

const KEYS = Object.freeze({
  // WP1 /settings (read by the punishment service, guard, WP2, WP4, WP5, WP6 ...)
  MUTED_ROLE: "muted_role",
  IMUTED_ROLE: "imuted_role",
  RMUTED_ROLE: "rmuted_role",
  JAIL_ROLE: "jail_role",
  JAIL_CHANNEL: "jail_channel",
  JAIL_MESSAGE: "jail_message", // script (core/script.js)
  JAIL_STRIP_ROLES: "jail_strip_roles", // boolean
  PREMIUM_ROLE: "premium_role",
  BASE_ROLE: "base_role", // booster roles are placed under it (WP4)
  DJ_ROLE: "dj_role",
  MODLOG_CHANNEL: "modlog_channel",
  JOINLOG_CHANNEL: "joinlog_channel",
  AUTONICK: "autonick",
  MUSIC_AUTOPLAY: "music_autoplay", // boolean, read by events/distube/initQueue.js
  DISABLE_CUSTOM_FMS: "disable_custom_fms",
  GOOGLE_SAFE: "google_safe",
});

const cache = guildCache((guildId) => {
  const map = new Map();
  for (const row of db.all("SELECT key, value FROM guild_config WHERE guild_id = ?", guildId))
    map.set(row.key, JSON.parse(row.value));
  return map;
});

const config = {
  KEYS,

  get(guildId, key, fallback) {
    const map = cache.get(guildId);
    return map.has(key) ? map.get(key) : fallback;
  },

  /** Every key for a guild as a plain object (for /settings config). */
  all(guildId) {
    return Object.fromEntries(cache.get(guildId));
  },

  set(guildId, key, value) {
    if (value === undefined || value === null) return config.remove(guildId, key);
    db.run(
      `INSERT INTO guild_config (guild_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value`,
      guildId,
      key,
      JSON.stringify(value)
    );
    cache.get(guildId).set(key, value);
    return value;
  },

  remove(guildId, ...keys) {
    for (const key of keys) {
      db.run("DELETE FROM guild_config WHERE guild_id = ? AND key = ?", guildId, key);
      cache.get(guildId).delete(key);
    }
  },
};

module.exports = config;
