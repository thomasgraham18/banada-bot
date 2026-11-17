/**
 * Suggestion system storage (WP5).
 *
 * Tables (all prefixed "suggest_"):
 *   suggest_settings  one row per guild: channels, review, lock, vote emojis, threads
 *   suggest_items     the suggestions, numbered per guild (#1, #2, ...)
 *   suggest_replies   staff responses ("/suggest reply")
 *   suggest_votes     one row per (suggestion, user): +1 or -1
 *   suggest_ignores   members / roles that may not create suggestions
 *
 * The package file calls the main table `suggestions`; it is `suggest_items`
 * here so every table carries the package prefix (CORE.md convention).
 */
const { db, guildCache } = require("../../core");

db.migrate(
  "suggest_001_init",
  `
  CREATE TABLE suggest_settings (
    guild_id          TEXT PRIMARY KEY,
    channel_id        TEXT,
    review_enabled    INTEGER NOT NULL DEFAULT 0,
    review_channel_id TEXT,
    locked            INTEGER NOT NULL DEFAULT 0,
    upvote            TEXT,              -- emoji text ("👍" or "<:name:id>"); NULL = default
    downvote          TEXT,
    threads           INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE suggest_items (
    guild_id      TEXT NOT NULL,
    id            INTEGER NOT NULL,      -- per-guild sequential number
    author_id     TEXT NOT NULL,
    author_name   TEXT,                  -- snapshot for the embed, so edits need no fetch
    author_avatar TEXT,
    content       TEXT NOT NULL,
    -- review | pending | consideration | progress | approved | denied
    status        TEXT NOT NULL,
    channel_id    TEXT,                  -- where the embed currently lives (review or public)
    message_id    TEXT,
    updated_by    TEXT,                  -- staff member who last changed the status
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER,
    PRIMARY KEY (guild_id, id)
  );

  CREATE TABLE suggest_replies (
    guild_id      TEXT NOT NULL,
    suggestion_id INTEGER NOT NULL,
    staff_id      TEXT NOT NULL,
    comment       TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX suggest_replies_by_item ON suggest_replies (guild_id, suggestion_id);

  CREATE TABLE suggest_votes (
    guild_id      TEXT NOT NULL,
    suggestion_id INTEGER NOT NULL,
    user_id       TEXT NOT NULL,
    vote          INTEGER NOT NULL CHECK (vote IN (1, -1)),
    PRIMARY KEY (guild_id, suggestion_id, user_id)
  );

  CREATE TABLE suggest_ignores (
    guild_id  TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('member', 'role')),
    PRIMARY KEY (guild_id, target_id)
  );
`
);

const DEFAULT_SETTINGS = {
  channel_id: null,
  review_enabled: 0,
  review_channel_id: null,
  locked: 0,
  upvote: null,
  downvote: null,
  threads: 0,
};

// Settings + ignores are read on every create / vote, so cache them.
const settingsCache = guildCache((guildId) => ({
  ...DEFAULT_SETTINGS,
  ...(db.get("SELECT * FROM suggest_settings WHERE guild_id = ?", guildId) ?? {}),
  guild_id: guildId,
}));
const ignoreCache = guildCache(
  (guildId) => new Set(db.all("SELECT target_id FROM suggest_ignores WHERE guild_id = ?", guildId).map((r) => r.target_id))
);

const SETTING_COLUMNS = Object.keys(DEFAULT_SETTINGS);

/** Settings with defaults filled in (cached). */
const getSettings = (guildId) => settingsCache.get(guildId);

/** Updates some settings columns, creating the row if needed. */
function updateSettings(guildId, changes) {
  const cols = Object.keys(changes).filter((c) => SETTING_COLUMNS.includes(c));
  if (!cols.length) return;
  db.run("INSERT OR IGNORE INTO suggest_settings (guild_id) VALUES (?)", guildId);
  const params = { guild_id: guildId };
  for (const c of cols) params[c] = changes[c];
  db.run(`UPDATE suggest_settings SET ${cols.map((c) => `${c} = :${c}`).join(", ")} WHERE guild_id = :guild_id`, params);
  settingsCache.invalidate(guildId);
}

// ---------------------------------------------------------------- ignores

const isIgnoredId = (guildId, id) => ignoreCache.get(guildId).has(id);

function addIgnore(guildId, targetId, kind) {
  const { changes } = db.run("INSERT OR IGNORE INTO suggest_ignores (guild_id, target_id, kind) VALUES (?, ?, ?)", guildId, targetId, kind);
  ignoreCache.invalidate(guildId);
  return changes > 0;
}

function removeIgnore(guildId, targetId) {
  const { changes } = db.run("DELETE FROM suggest_ignores WHERE guild_id = ? AND target_id = ?", guildId, targetId);
  ignoreCache.invalidate(guildId);
  return changes > 0;
}

const listIgnores = (guildId) => db.all("SELECT target_id, kind FROM suggest_ignores WHERE guild_id = ? ORDER BY kind, target_id", guildId);

// ---------------------------------------------------------------- suggestions

/** Inserts a suggestion with the next per-guild number and returns the row. */
function createSuggestion(guildId, { authorId, authorName, authorAvatar, content, status }) {
  return db.transaction(() => {
    const id = (db.get("SELECT MAX(id) AS max FROM suggest_items WHERE guild_id = ?", guildId)?.max ?? 0) + 1;
    db.run(
      `INSERT INTO suggest_items (guild_id, id, author_id, author_name, author_avatar, content, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      guildId, id, authorId, authorName, authorAvatar, content, status, Date.now()
    );
    return getSuggestion(guildId, id);
  });
}

const getSuggestion = (guildId, id) => db.get("SELECT * FROM suggest_items WHERE guild_id = ? AND id = ?", guildId, id);

const deleteSuggestion = (guildId, id) =>
  db.transaction(() => {
    db.run("DELETE FROM suggest_items WHERE guild_id = ? AND id = ?", guildId, id);
    db.run("DELETE FROM suggest_votes WHERE guild_id = ? AND suggestion_id = ?", guildId, id);
    db.run("DELETE FROM suggest_replies WHERE guild_id = ? AND suggestion_id = ?", guildId, id);
  });

/** Most recent first, for autocomplete. */
const recentSuggestions = (guildId, limit = 25) =>
  db.all("SELECT id, status, content FROM suggest_items WHERE guild_id = ? ORDER BY id DESC LIMIT ?", guildId, limit);

/** Searches by number or content, for autocomplete. */
const searchSuggestions = (guildId, text, limit = 25) =>
  db.all(
    "SELECT id, status, content FROM suggest_items WHERE guild_id = ? AND (CAST(id AS TEXT) LIKE ? OR content LIKE ?) ORDER BY id DESC LIMIT ?",
    guildId, `${text}%`, `%${text}%`, limit
  );

function setLocation(guildId, id, channelId, messageId) {
  db.run("UPDATE suggest_items SET channel_id = ?, message_id = ? WHERE guild_id = ? AND id = ?", channelId, messageId, guildId, id);
}

function setStatus(guildId, id, status, staffId) {
  db.run(
    "UPDATE suggest_items SET status = ?, updated_by = ?, updated_at = ? WHERE guild_id = ? AND id = ?",
    status, staffId, Date.now(), guildId, id
  );
}

// ---------------------------------------------------------------- replies

function addReply(guildId, suggestionId, staffId, comment) {
  db.run(
    "INSERT INTO suggest_replies (guild_id, suggestion_id, staff_id, comment, created_at) VALUES (?, ?, ?, ?, ?)",
    guildId, suggestionId, staffId, comment, Date.now()
  );
}

/** The newest `limit` replies, oldest first (display order). */
const latestReplies = (guildId, suggestionId, limit) =>
  db
    .all(
      "SELECT staff_id, comment, created_at FROM suggest_replies WHERE guild_id = ? AND suggestion_id = ? ORDER BY rowid DESC LIMIT ?",
      guildId, suggestionId, limit
    )
    .reverse();

const countReplies = (guildId, suggestionId) =>
  db.get("SELECT COUNT(*) AS n FROM suggest_replies WHERE guild_id = ? AND suggestion_id = ?", guildId, suggestionId).n;

// ---------------------------------------------------------------- votes

/**
 * One vote per user. Clicking the same button again removes the vote;
 * clicking the other one switches it. Returns "added" | "changed" | "removed".
 */
function castVote(guildId, suggestionId, userId, vote) {
  return db.transaction(() => {
    const existing = db.get(
      "SELECT vote FROM suggest_votes WHERE guild_id = ? AND suggestion_id = ? AND user_id = ?",
      guildId, suggestionId, userId
    );
    if (existing?.vote === vote) {
      db.run("DELETE FROM suggest_votes WHERE guild_id = ? AND suggestion_id = ? AND user_id = ?", guildId, suggestionId, userId);
      return "removed";
    }
    db.run(
      `INSERT INTO suggest_votes (guild_id, suggestion_id, user_id, vote) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, suggestion_id, user_id) DO UPDATE SET vote = excluded.vote`,
      guildId, suggestionId, userId, vote
    );
    return existing ? "changed" : "added";
  });
}

function voteCounts(guildId, suggestionId) {
  const counts = { up: 0, down: 0 };
  for (const row of db.all(
    "SELECT vote, COUNT(*) AS n FROM suggest_votes WHERE guild_id = ? AND suggestion_id = ? GROUP BY vote",
    guildId, suggestionId
  ))
    counts[row.vote === 1 ? "up" : "down"] = row.n;
  return counts;
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  isIgnoredId,
  addIgnore,
  removeIgnore,
  listIgnores,
  createSuggestion,
  getSuggestion,
  deleteSuggestion,
  recentSuggestions,
  searchSuggestions,
  setLocation,
  setStatus,
  addReply,
  latestReplies,
  countReplies,
  castVote,
  voteCounts,
};
