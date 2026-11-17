/**
 * Giveaways data model + queries.
 *
 * Every giveaway gets an internal integer id (giveaways.id). That id is in the
 * Enter button's custom ID ("gw:enter:12") and is the scheduler key, because
 * the button must exist before the message (and its ID) does. The message ID
 * is still stored, and users refer to giveaways by message ID or link.
 *
 * Entries are rows in giveaways_entries, never reaction counts.
 */
const { db } = require("../../core");

db.migrate(
  "giveaways_001_init",
  `
  CREATE TABLE giveaways (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    message_id    TEXT UNIQUE,              -- NULL only while the message is being posted
    prize         TEXT NOT NULL,
    description   TEXT,
    color         INTEGER,
    image         TEXT,                     -- URL, or attachment://gw-image.ext
    thumbnail     TEXT,                     -- URL, or attachment://gw-thumbnail.ext
    winners       INTEGER NOT NULL DEFAULT 1,
    hide_winners  INTEGER NOT NULL DEFAULT 0,
    min_level     INTEGER NOT NULL DEFAULT 0,  -- 0 = no requirement
    max_level     INTEGER NOT NULL DEFAULT 0,  -- 0 = no requirement
    min_age_days  INTEGER NOT NULL DEFAULT 0,
    min_stay_days INTEGER NOT NULL DEFAULT 0,
    ends_at       INTEGER NOT NULL,         -- unix ms
    ended         INTEGER NOT NULL DEFAULT 0,
    ended_at      INTEGER,
    cancelled     INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX giveaways_guild ON giveaways (guild_id, ended);

  CREATE TABLE giveaways_hosts (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );
  CREATE TABLE giveaways_required_roles (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
    role_id     TEXT NOT NULL,
    PRIMARY KEY (giveaway_id, role_id)
  );
  CREATE TABLE giveaways_award_roles (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
    role_id     TEXT NOT NULL,
    PRIMARY KEY (giveaway_id, role_id)
  );
  CREATE TABLE giveaways_entries (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    entered_at  INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );
  CREATE TABLE giveaways_winners (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    rerolled    INTEGER NOT NULL DEFAULT 0,  -- 1 = picked by /giveaways reroll
    picked_at   INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );
  `
);

// ---------------------------------------------------------------- giveaways

/** Columns a /giveaways edit subcommand may change directly. */
const EDITABLE = new Set([
  "prize", "description", "color", "image", "thumbnail", "winners", "hide_winners",
  "min_level", "max_level", "min_age_days", "min_stay_days", "ends_at",
]);

function create({ guildId, channelId, prize, winners, color, endsAt, createdBy }) {
  return db.transaction(() => {
    const id = Number(
      db.run(
        `INSERT INTO giveaways (guild_id, channel_id, prize, winners, color, ends_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        guildId, channelId, prize, winners, color, endsAt, createdBy, Date.now()
      ).lastInsertRowid
    );
    db.run("INSERT INTO giveaways_hosts (giveaway_id, user_id) VALUES (?, ?)", id, createdBy);
    return id;
  });
}

const setMessage = (id, messageId) => db.run("UPDATE giveaways SET message_id = ? WHERE id = ?", messageId, id);

function update(id, column, value) {
  if (!EDITABLE.has(column)) throw new Error(`giveaways: column ${column} is not editable`);
  db.run(`UPDATE giveaways SET ${column} = ? WHERE id = ?`, value, id);
}

const markEnded = (id) => db.run("UPDATE giveaways SET ended = 1, ended_at = ? WHERE id = ? AND ended = 0", Date.now(), id).changes > 0;
const remove = (id) => db.run("DELETE FROM giveaways WHERE id = ?", id);

/** One giveaway with its hosts, role lists and counts, or undefined. */
function get(id) {
  const row = db.get("SELECT * FROM giveaways WHERE id = ?", id);
  return row ? hydrate(row) : undefined;
}

const getByMessage = (guildId, messageId) => {
  const row = db.get("SELECT * FROM giveaways WHERE guild_id = ? AND message_id = ?", guildId, messageId);
  return row ? hydrate(row) : undefined;
};

function hydrate(row) {
  const ids = (table, column) => db.all(`SELECT ${column} FROM ${table} WHERE giveaway_id = ?`, row.id).map((r) => r[column]);
  return {
    ...row,
    hide_winners: Boolean(row.hide_winners),
    ended: Boolean(row.ended),
    cancelled: Boolean(row.cancelled),
    hosts: ids("giveaways_hosts", "user_id"),
    required_roles: ids("giveaways_required_roles", "role_id"),
    award_roles: ids("giveaways_award_roles", "role_id"),
    winner_ids: listWinners(row.id).map((w) => w.user_id),
    entry_count: countEntries(row.id),
  };
}

/** Lightweight rows (no hydration) for list / autocomplete. */
const listForGuild = (guildId, { ended } = {}) =>
  db.all(
    `SELECT g.*, (SELECT COUNT(*) FROM giveaways_entries e WHERE e.giveaway_id = g.id) AS entry_count
     FROM giveaways g
     WHERE g.guild_id = ? AND g.message_id IS NOT NULL AND g.cancelled = 0 AND (? IS NULL OR g.ended = ?)
     ORDER BY g.ended ASC, CASE WHEN g.ended = 0 THEN g.ends_at ELSE -g.ended_at END ASC`,
    guildId, ended == null ? null : Number(ended), ended == null ? null : Number(ended)
  );

/** The most recently ended giveaway in a channel (reroll's default). */
const latestEndedInChannel = (guildId, channelId) =>
  db.get("SELECT id FROM giveaways WHERE guild_id = ? AND channel_id = ? AND ended = 1 ORDER BY ended_at DESC LIMIT 1", guildId, channelId)?.id;

// ---------------------------------------------------------------- id lists

/** Replaces one of the per-giveaway id lists (hosts / required roles / award roles). */
function replaceList(kind, id, values) {
  const table = { hosts: ["giveaways_hosts", "user_id"], required: ["giveaways_required_roles", "role_id"], award: ["giveaways_award_roles", "role_id"] }[kind];
  if (!table) throw new Error(`giveaways: unknown list ${kind}`);
  const [name, column] = table;
  db.transaction(() => {
    db.run(`DELETE FROM ${name} WHERE giveaway_id = ?`, id);
    for (const value of new Set(values)) db.run(`INSERT INTO ${name} (giveaway_id, ${column}) VALUES (?, ?)`, id, value);
  });
}

// ---------------------------------------------------------------- entries / winners

/** Returns true if the user was added (false if they were already in). */
const addEntry = (id, userId) =>
  db.run("INSERT OR IGNORE INTO giveaways_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)", id, userId, Date.now()).changes > 0;
const removeEntry = (id, userId) => db.run("DELETE FROM giveaways_entries WHERE giveaway_id = ? AND user_id = ?", id, userId).changes > 0;
const hasEntry = (id, userId) => Boolean(db.get("SELECT 1 AS x FROM giveaways_entries WHERE giveaway_id = ? AND user_id = ?", id, userId));
const countEntries = (id) => db.get("SELECT COUNT(*) AS n FROM giveaways_entries WHERE giveaway_id = ?", id).n;
const listEntries = (id) => db.all("SELECT user_id FROM giveaways_entries WHERE giveaway_id = ? ORDER BY entered_at", id).map((r) => r.user_id);

const listWinners = (id) => db.all("SELECT * FROM giveaways_winners WHERE giveaway_id = ? ORDER BY picked_at, rowid", id);
function addWinners(id, userIds, { rerolled = false } = {}) {
  const now = Date.now();
  db.transaction(() => {
    for (const userId of userIds)
      db.run("INSERT OR IGNORE INTO giveaways_winners (giveaway_id, user_id, rerolled, picked_at) VALUES (?, ?, ?, ?)", id, userId, rerolled, now);
  });
}

module.exports = {
  create, setMessage, update, markEnded, remove, get, getByMessage, listForGuild, latestEndedInChannel,
  replaceList, addEntry, removeEntry, hasEntry, countEntries, listEntries, listWinners, addWinners,
};
