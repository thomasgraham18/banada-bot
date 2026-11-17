/**
 * Filter tables, queries and the per-guild compiled-rules cache.
 *
 * Every write function invalidates the guild's cache, so the message listener
 * always sees fresh rules without querying the database per message.
 */
const { db, config, guildCache } = require("../../core");
const { compileGuild } = require("./match");
const { CONFIG } = require("./constants");

db.migrate("filter_001_init", `
  -- channel_id '' = the server default; any other value = a per-channel override.
  -- NULL columns in an override inherit the server default.
  CREATE TABLE filter_settings (
    guild_id    TEXT NOT NULL,
    type        TEXT NOT NULL,
    channel_id  TEXT NOT NULL DEFAULT '',
    enabled     INTEGER,
    threshold   INTEGER,
    punishment  TEXT,
    duration_ms INTEGER,
    PRIMARY KEY (guild_id, type, channel_id)
  );
  CREATE TABLE filter_exempt (
    guild_id TEXT NOT NULL,
    type     TEXT NOT NULL,
    role_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, type, role_id)
  );
  -- kind: block (filtered word, * wildcards), allow, regex
  CREATE TABLE filter_words (
    guild_id TEXT NOT NULL,
    word     TEXT NOT NULL,
    kind     TEXT NOT NULL,
    added_by TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, word)
  );
  CREATE TABLE filter_urls (
    guild_id TEXT NOT NULL,
    host     TEXT NOT NULL,
    PRIMARY KEY (guild_id, host)
  );
  CREATE TABLE filter_points_config (
    guild_id TEXT NOT NULL,
    type     TEXT NOT NULL,
    points   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, type)
  );
  CREATE TABLE filter_ladder (
    guild_id    TEXT NOT NULL,
    points      INTEGER NOT NULL,
    punishment  TEXT NOT NULL,
    duration_ms INTEGER,
    PRIMARY KEY (guild_id, points)
  );
  CREATE TABLE filter_points (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    points     INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  -- Discord AutoMod rules this bot created and keeps in sync.
  CREATE TABLE filter_automod_rules (
    guild_id TEXT NOT NULL,
    type     TEXT NOT NULL,
    rule_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, type)
  );
  CREATE TABLE filter_snipe (
    guild_id TEXT NOT NULL,
    type     TEXT NOT NULL,
    enabled  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, type)
  );
`);

/** Compiled rules per guild (see match.compileGuild). */
const rules = guildCache((guildId) =>
  compileGuild({
    settings: db.all("SELECT * FROM filter_settings WHERE guild_id = ?", guildId),
    exempt: db.all("SELECT type, role_id FROM filter_exempt WHERE guild_id = ?", guildId),
    words: db.all("SELECT word, kind FROM filter_words WHERE guild_id = ? ORDER BY added_at", guildId),
    urls: db.all("SELECT host FROM filter_urls WHERE guild_id = ?", guildId),
    points: db.all("SELECT type, points FROM filter_points_config WHERE guild_id = ?", guildId),
    ladder: db.all("SELECT points, punishment, duration_ms FROM filter_ladder WHERE guild_id = ?", guildId),
    limit: config.get(guildId, CONFIG.POINTS_LIMIT, null),
    snipe: db.all("SELECT type, enabled FROM filter_snipe WHERE guild_id = ?", guildId),
  })
);

/** Runs `fn` then drops the guild's compiled rules. */
const write = (guildId, fn) => {
  const result = fn();
  rules.invalidate(guildId);
  return result;
};

// ------------------------------------------------------------------ settings

/**
 * Upserts a server default (channelId '') or channel override. Fields left
 * null keep their previous value (partial update).
 */
function setSetting(guildId, type, channelId, { enabled, threshold = null, punishment = null, durationMs = null }) {
  return write(guildId, () =>
    db.run(
      `INSERT INTO filter_settings (guild_id, type, channel_id, enabled, threshold, punishment, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, type, channel_id) DO UPDATE SET
         enabled = excluded.enabled,
         threshold = COALESCE(excluded.threshold, threshold),
         punishment = COALESCE(excluded.punishment, punishment),
         duration_ms = COALESCE(excluded.duration_ms, duration_ms)`,
      guildId, type, channelId ?? "", enabled, threshold, punishment, durationMs
    )
  );
}

/** Deletes channel overrides for a type: one channel, or all of them. */
const clearOverrides = (guildId, type, channelId) =>
  write(guildId, () =>
    channelId
      ? db.run("DELETE FROM filter_settings WHERE guild_id = ? AND type = ? AND channel_id = ?", guildId, type, channelId)
      : db.run("DELETE FROM filter_settings WHERE guild_id = ? AND type = ? AND channel_id != ''", guildId, type)
  );

/** /access copy: duplicates every override of one channel onto another. */
const copyChannelSettings = (guildId, fromId, toId) =>
  write(guildId, () =>
    db.run(
      `INSERT OR REPLACE INTO filter_settings (guild_id, type, channel_id, enabled, threshold, punishment, duration_ms)
       SELECT guild_id, type, ?, enabled, threshold, punishment, duration_ms
       FROM filter_settings WHERE guild_id = ? AND channel_id = ?`,
      toId, guildId, fromId
    )
  );

// ------------------------------------------------------------------ exemptions

const setExempt = (guildId, type, roleId, exempt) =>
  write(guildId, () =>
    exempt
      ? db.run("INSERT OR IGNORE INTO filter_exempt (guild_id, type, role_id) VALUES (?, ?, ?)", guildId, type, roleId)
      : db.run("DELETE FROM filter_exempt WHERE guild_id = ? AND type = ? AND role_id = ?", guildId, type, roleId)
  );

// ------------------------------------------------------------------ words

const listWords = (guildId, kind) =>
  db.all("SELECT word FROM filter_words WHERE guild_id = ? AND kind = ? ORDER BY added_at", guildId, kind).map((r) => r.word);

const countWords = (guildId, kind) => db.get("SELECT COUNT(*) AS n FROM filter_words WHERE guild_id = ? AND kind = ?", guildId, kind).n;

const addWord = (guildId, kind, word, userId) =>
  write(guildId, () =>
    db.run("INSERT OR IGNORE INTO filter_words (guild_id, word, kind, added_by, added_at) VALUES (?, ?, ?, ?, ?)", guildId, word, kind, userId, Date.now())
  );

const removeWord = (guildId, kind, word) =>
  write(guildId, () => db.run("DELETE FROM filter_words WHERE guild_id = ? AND kind = ? AND word = ?", guildId, kind, word));

/** /filter word reset: clears the block list (allowed words and regex stay). */
const resetWords = (guildId) => write(guildId, () => db.run("DELETE FROM filter_words WHERE guild_id = ? AND kind = 'block'", guildId));

// ------------------------------------------------------------------ urls

const listUrls = (guildId) => db.all("SELECT host FROM filter_urls WHERE guild_id = ? ORDER BY host", guildId).map((r) => r.host);
const setUrl = (guildId, host, allowed) =>
  write(guildId, () =>
    allowed
      ? db.run("INSERT OR IGNORE INTO filter_urls (guild_id, host) VALUES (?, ?)", guildId, host)
      : db.run("DELETE FROM filter_urls WHERE guild_id = ? AND host = ?", guildId, host)
  );

// ------------------------------------------------------------------ points

/** Replaces the point values and the ladder in one go (/filter points setup). */
function savePointsSetup(guildId, values, ladder) {
  return write(guildId, () =>
    db.transaction(() => {
      db.run("DELETE FROM filter_points_config WHERE guild_id = ?", guildId);
      for (const [type, points] of values) db.run("INSERT INTO filter_points_config (guild_id, type, points) VALUES (?, ?, ?)", guildId, type, points);
      db.run("DELETE FROM filter_ladder WHERE guild_id = ?", guildId);
      for (const s of ladder)
        db.run("INSERT INTO filter_ladder (guild_id, points, punishment, duration_ms) VALUES (?, ?, ?, ?)", guildId, s.points, s.punishment, s.durationMs);
    })
  );
}

const setPointsLimit = (guildId, limit) =>
  write(guildId, () => (limit ? config.set(guildId, CONFIG.POINTS_LIMIT, limit) : config.remove(guildId, CONFIG.POINTS_LIMIT)));

/** Raw stored points row ({ points, updated_at }) or null. Decay is applied by the caller. */
const getPointsRow = (guildId, userId) => db.get("SELECT points, updated_at FROM filter_points WHERE guild_id = ? AND user_id = ?", guildId, userId) ?? null;

function savePoints(guildId, userId, points, now = Date.now()) {
  if (points <= 0) db.run("DELETE FROM filter_points WHERE guild_id = ? AND user_id = ?", guildId, userId);
  else
    db.run(
      `INSERT INTO filter_points (guild_id, user_id, points, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at`,
      guildId, userId, points, now
    );
}

// ------------------------------------------------------------------ automod + snipe

const getAutomodRule = (guildId, type) => db.get("SELECT rule_id FROM filter_automod_rules WHERE guild_id = ? AND type = ?", guildId, type)?.rule_id ?? null;
const setAutomodRule = (guildId, type, ruleId) =>
  ruleId
    ? db.run("INSERT OR REPLACE INTO filter_automod_rules (guild_id, type, rule_id) VALUES (?, ?, ?)", guildId, type, ruleId)
    : db.run("DELETE FROM filter_automod_rules WHERE guild_id = ? AND type = ?", guildId, type);

const setSnipe = (guildId, type, enabled) =>
  write(guildId, () => db.run("INSERT OR REPLACE INTO filter_snipe (guild_id, type, enabled) VALUES (?, ?, ?)", guildId, type, enabled));

/** Staff roles from /settings staff (core table, read-only here) for AutoMod exemptions. */
const staffRoles = (guildId) => db.all("SELECT role_id FROM staff_roles WHERE guild_id = ?", guildId).map((r) => r.role_id);

module.exports = {
  rules,
  setSetting, clearOverrides, copyChannelSettings,
  setExempt,
  listWords, countWords, addWord, removeWord, resetWords,
  listUrls, setUrl,
  savePointsSetup, setPointsLimit, getPointsRow, savePoints,
  getAutomodRule, setAutomodRule,
  setSnipe, staffRoles,
};
