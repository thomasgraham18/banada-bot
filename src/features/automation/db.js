/**
 * Storage for /automation.
 *
 * Single-valued settings (pin archive, reposter toggles, timer activity) live
 * in guild_config under the KEYS below. Everything with several rows per
 * guild has its own table. Hot-path reads (message listeners) go through the
 * guildCache wrappers at the bottom; every write invalidates them.
 */
const { db, config, guildCache } = require("../../core");

db.migrate(
  "automation_001_init",
  `CREATE TABLE IF NOT EXISTS automation_paginations (
    message_id  TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    pages_json  TEXT NOT NULL,          -- JSON array of scripts, page 1 first
    created_by  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automation_paginations_guild ON automation_paginations (guild_id);

  -- Pins already copied to the archive channel, so nothing is posted twice.
  CREATE TABLE IF NOT EXISTS automation_pins_archived (
    guild_id    TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    archived_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS automation_publisher_channels (
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL PRIMARY KEY
  );
  CREATE INDEX IF NOT EXISTS automation_publisher_guild ON automation_publisher_channels (guild_id);

  CREATE TABLE IF NOT EXISTS automation_counters (
    channel_id    TEXT PRIMARY KEY,
    guild_id      TEXT NOT NULL,
    option        TEXT NOT NULL,
    prettify      INTEGER NOT NULL DEFAULT 0,
    currency      TEXT,
    name_template TEXT NOT NULL,
    last_name     TEXT,                 -- the name we last asked Discord for
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automation_counters_guild ON automation_counters (guild_id);

  CREATE TABLE IF NOT EXISTS automation_timers (
    channel_id      TEXT PRIMARY KEY,   -- one repeating message per channel
    guild_id        TEXT NOT NULL,
    script          TEXT NOT NULL,
    interval_ms     INTEGER NOT NULL,
    last_message_id TEXT,
    last_post_at    INTEGER,
    created_by      TEXT
  );
  CREATE INDEX IF NOT EXISTS automation_timers_guild ON automation_timers (guild_id);

  CREATE TABLE IF NOT EXISTS automation_leaderboards (
    guild_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- messages | voice | levels | invites
    timeframe   TEXT NOT NULL,          -- daily | weekly | monthly | alltime
    channel_id  TEXT NOT NULL,
    message_id  TEXT,
    script      TEXT,                   -- NULL = default message
    PRIMARY KEY (guild_id, kind, timeframe)
  );

  CREATE TABLE IF NOT EXISTS automation_leaderboard_emotes (
    guild_id TEXT NOT NULL,
    kind     TEXT NOT NULL,
    rank     INTEGER NOT NULL,
    emote    TEXT NOT NULL,
    PRIMARY KEY (guild_id, kind, rank)
  );

  -- Daily buckets (period_start = UTC midnight) plus an all-time row
  -- (period_start = 0). Voice values are seconds.
  CREATE TABLE IF NOT EXISTS automation_activity_stats (
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    kind         TEXT NOT NULL,         -- messages | voice | invites
    period_start INTEGER NOT NULL,
    value        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, kind, period_start, user_id)
  );`
);

/** guild_config keys owned by this package. */
const KEYS = {
  PINS: "automation_pins", // { enabled, unpin, channelId }
  REPOSTER: "automation_reposter", // { enabled, embed, delete, suppress, prefix, strict }
  TIMER_ACTIVITY: "automation_timer_activity", // boolean
};

const PIN_DEFAULTS = { enabled: false, unpin: false, channelId: null };
const REPOSTER_DEFAULTS = { enabled: false, embed: true, delete: false, suppress: true, prefix: false, strict: false };

const pins = {
  get: (guildId) => ({ ...PIN_DEFAULTS, ...config.get(guildId, KEYS.PINS, {}) }),
  set: (guildId, patch) => config.set(guildId, KEYS.PINS, { ...pins.get(guildId), ...patch }),
  reset: (guildId) => config.remove(guildId, KEYS.PINS),
  isArchived: (guildId, messageId) => !!db.get("SELECT 1 FROM automation_pins_archived WHERE guild_id = ? AND message_id = ?", guildId, messageId),
  markArchived: (guildId, messageId) =>
    db.run("INSERT OR IGNORE INTO automation_pins_archived (guild_id, message_id, archived_at) VALUES (?, ?, ?)", guildId, messageId, Date.now()),
  clearArchived: (guildId) => db.run("DELETE FROM automation_pins_archived WHERE guild_id = ?", guildId),
};

const reposter = {
  get: (guildId) => ({ ...REPOSTER_DEFAULTS, ...config.get(guildId, KEYS.REPOSTER, {}) }),
  set: (guildId, patch) => config.set(guildId, KEYS.REPOSTER, { ...reposter.get(guildId), ...patch }),
};

// ---------------------------------------------------------------- pagination

const paginations = {
  get(messageId) {
    const row = db.get("SELECT * FROM automation_paginations WHERE message_id = ?", messageId);
    return row ? { ...row, pages: JSON.parse(row.pages_json) } : null;
  },
  list: (guildId) => db.all("SELECT * FROM automation_paginations WHERE guild_id = ? ORDER BY created_at", guildId).map((r) => ({ ...r, pages: JSON.parse(r.pages_json) })),
  count: (guildId) => db.get("SELECT COUNT(*) AS n FROM automation_paginations WHERE guild_id = ?", guildId).n,
  create: (message, pages, userId) =>
    db.run(
      "INSERT INTO automation_paginations (message_id, guild_id, channel_id, pages_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      message.id, message.guildId, message.channelId, JSON.stringify(pages), userId, Date.now()
    ),
  setPages: (messageId, pages) => db.run("UPDATE automation_paginations SET pages_json = ? WHERE message_id = ?", JSON.stringify(pages), messageId),
  remove: (messageId) => db.run("DELETE FROM automation_paginations WHERE message_id = ?", messageId).changes,
  removeAll: (guildId) => db.run("DELETE FROM automation_paginations WHERE guild_id = ?", guildId).changes,
};

// ---------------------------------------------------------------- publisher

/** Set of announcement channel IDs to auto-publish in (cached; read per message). */
const publisherCache = guildCache((guildId) =>
  new Set(db.all("SELECT channel_id FROM automation_publisher_channels WHERE guild_id = ?", guildId).map((r) => r.channel_id))
);

const publisher = {
  list: (guildId) => [...publisherCache.get(guildId)],
  has: (guildId, channelId) => publisherCache.get(guildId).has(channelId),
  add(guildId, channelId) {
    const r = db.run("INSERT OR IGNORE INTO automation_publisher_channels (guild_id, channel_id) VALUES (?, ?)", guildId, channelId);
    publisherCache.invalidate(guildId);
    return r.changes;
  },
  remove(guildId, channelId) {
    const r = db.run("DELETE FROM automation_publisher_channels WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    publisherCache.invalidate(guildId);
    return r.changes;
  },
};

// ---------------------------------------------------------------- counters

const counters = {
  get: (channelId) => {
    const row = db.get("SELECT * FROM automation_counters WHERE channel_id = ?", channelId);
    return row ? { ...row, prettify: !!row.prettify } : null;
  },
  list: (guildId) => db.all("SELECT * FROM automation_counters WHERE guild_id = ? ORDER BY created_at", guildId).map((r) => ({ ...r, prettify: !!r.prettify })),
  count: (guildId) => db.get("SELECT COUNT(*) AS n FROM automation_counters WHERE guild_id = ?", guildId).n,
  upsert: (row) =>
    db.run(
      `INSERT INTO automation_counters (channel_id, guild_id, option, prettify, currency, name_template, last_name, created_at)
       VALUES (:channel_id, :guild_id, :option, :prettify, :currency, :name_template, :last_name, :created_at)
       ON CONFLICT (channel_id) DO UPDATE SET option = excluded.option, prettify = excluded.prettify,
         currency = excluded.currency, name_template = excluded.name_template, last_name = excluded.last_name`,
      { last_name: null, created_at: Date.now(), ...row }
    ),
  setLastName: (channelId, name) => db.run("UPDATE automation_counters SET last_name = ? WHERE channel_id = ?", name, channelId),
  remove: (channelId) => db.run("DELETE FROM automation_counters WHERE channel_id = ?", channelId).changes,
};

// ---------------------------------------------------------------- timers

const timers = {
  get: (channelId) => db.get("SELECT * FROM automation_timers WHERE channel_id = ?", channelId) ?? null,
  list: (guildId) => db.all("SELECT * FROM automation_timers WHERE guild_id = ? ORDER BY channel_id", guildId),
  count: (guildId) => db.get("SELECT COUNT(*) AS n FROM automation_timers WHERE guild_id = ?", guildId).n,
  upsert: ({ channelId, guildId, script, intervalMs, userId }) =>
    db.run(
      `INSERT INTO automation_timers (channel_id, guild_id, script, interval_ms, created_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET script = excluded.script, interval_ms = excluded.interval_ms`,
      channelId, guildId, script, intervalMs, userId
    ),
  posted: (channelId, messageId) =>
    db.run("UPDATE automation_timers SET last_message_id = ?, last_post_at = ? WHERE channel_id = ?", messageId, Date.now(), channelId),
  remove: (channelId) => db.run("DELETE FROM automation_timers WHERE channel_id = ?", channelId).changes,
  activity: (guildId) => Boolean(config.get(guildId, KEYS.TIMER_ACTIVITY, false)),
  setActivity: (guildId, value) => config.set(guildId, KEYS.TIMER_ACTIVITY, Boolean(value)),
};

// ---------------------------------------------------------------- leaderboards

/** Which activity kinds a guild has boards for, so listeners only track what's used. */
const trackedKinds = guildCache((guildId) =>
  new Set(db.all("SELECT DISTINCT kind FROM automation_leaderboards WHERE guild_id = ?", guildId).map((r) => r.kind))
);

const boards = {
  get: (guildId, kind, timeframe) =>
    db.get("SELECT * FROM automation_leaderboards WHERE guild_id = ? AND kind = ? AND timeframe = ?", guildId, kind, timeframe) ?? null,
  list: (guildId) => db.all("SELECT * FROM automation_leaderboards WHERE guild_id = ? ORDER BY kind, timeframe", guildId),
  /** Guilds with at least one board of `kind` (used on boot to seed trackers). */
  guildsWithKind: (kind) => db.all("SELECT DISTINCT guild_id FROM automation_leaderboards WHERE kind = ?", kind).map((r) => r.guild_id),
  upsertChannel(guildId, kind, timeframe, channelId) {
    db.run(
      `INSERT INTO automation_leaderboards (guild_id, kind, timeframe, channel_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, kind, timeframe) DO UPDATE SET channel_id = excluded.channel_id, message_id = NULL`,
      guildId, kind, timeframe, channelId
    );
    trackedKinds.invalidate(guildId);
  },
  setMessage: (guildId, kind, timeframe, messageId) =>
    db.run("UPDATE automation_leaderboards SET message_id = ? WHERE guild_id = ? AND kind = ? AND timeframe = ?", messageId, guildId, kind, timeframe),
  setScript: (guildId, kind, timeframe, stored) =>
    db.run("UPDATE automation_leaderboards SET script = ? WHERE guild_id = ? AND kind = ? AND timeframe = ?", stored, guildId, kind, timeframe),
  remove(guildId, kind, timeframe) {
    const r = db.run("DELETE FROM automation_leaderboards WHERE guild_id = ? AND kind = ? AND timeframe = ?", guildId, kind, timeframe);
    trackedKinds.invalidate(guildId);
    return r.changes;
  },
  emotes(guildId, kind) {
    const out = {};
    for (const r of db.all("SELECT rank, emote FROM automation_leaderboard_emotes WHERE guild_id = ? AND kind = ?", guildId, kind)) out[r.rank] = r.emote;
    return out;
  },
  setEmote(guildId, kind, rank, emote) {
    if (emote == null) db.run("DELETE FROM automation_leaderboard_emotes WHERE guild_id = ? AND kind = ? AND rank = ?", guildId, kind, rank);
    else
      db.run(
        `INSERT INTO automation_leaderboard_emotes (guild_id, kind, rank, emote) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, kind, rank) DO UPDATE SET emote = excluded.emote`,
        guildId, kind, rank, emote
      );
  },
  setEmotes(guildId, kind, list) {
    db.transaction(() => {
      db.run("DELETE FROM automation_leaderboard_emotes WHERE guild_id = ? AND kind = ?", guildId, kind);
      list.forEach((emote, i) => boards.setEmote(guildId, kind, i + 1, emote));
    });
  },
};

// ---------------------------------------------------------------- activity stats

const stats = {
  /** Adds `amount` to a user's daily bucket and all-time total. */
  add(guildId, userId, kind, amount, bucket) {
    const sql = `INSERT INTO automation_activity_stats (guild_id, user_id, kind, period_start, value) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (guild_id, kind, period_start, user_id) DO UPDATE SET value = value + excluded.value`;
    db.run(sql, guildId, userId, kind, bucket, amount);
    db.run(sql, guildId, userId, kind, 0, amount);
  },
  /** Top users since `from` (0 = the all-time row). */
  top(guildId, kind, from, limit, offset = 0) {
    if (from === 0)
      return db.all(
        "SELECT user_id AS userId, value FROM automation_activity_stats WHERE guild_id = ? AND kind = ? AND period_start = 0 AND value > 0 ORDER BY value DESC LIMIT ? OFFSET ?",
        guildId, kind, limit, offset
      );
    return db.all(
      `SELECT user_id AS userId, SUM(value) AS value FROM automation_activity_stats
       WHERE guild_id = ? AND kind = ? AND period_start >= ? GROUP BY user_id HAVING SUM(value) > 0
       ORDER BY value DESC LIMIT ? OFFSET ?`,
      guildId, kind, from, limit, offset
    );
  },
  /** Drops daily buckets older than `before` (all-time rows are kept). */
  prune: (before) => db.run("DELETE FROM automation_activity_stats WHERE period_start > 0 AND period_start < ?", before).changes,
};

module.exports = { KEYS, pins, reposter, paginations, publisher, counters, timers, boards, trackedKinds, stats };
