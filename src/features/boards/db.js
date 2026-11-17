/**
 * Storage for /starboard and /clownboard. Both boards share the tables; the
 * `kind` column says which board a row belongs to.
 *
 * Listeners never query these tables directly: they read `settings` and
 * `posts` (guildCache), and every write below invalidates the cache it touches.
 */
const { db, guildCache } = require("../../core");
const engine = require("./engine");

db.migrate(
  "boards_001_init",
  `
  -- One row per guild and board. NULL = use the default (engine.DEFAULTS / KINDS),
  -- which is how "/starboard clear <setting>" resets a setting.
  CREATE TABLE boards (
    guild_id    TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('starboard', 'clownboard')),
    channel_id  TEXT,
    emoji       TEXT,                  -- as typed: "⭐" or "<:name:id>"
    color       INTEGER,
    threshold   INTEGER,
    selfstar    INTEGER,
    attachments INTEGER,
    jumpurl     INTEGER,
    timestamp   INTEGER,
    locked      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, kind)
  );

  -- Channels (or categories), members and roles whose messages can't get new posts.
  CREATE TABLE board_ignores (
    guild_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('channel', 'member', 'role')),
    PRIMARY KEY (guild_id, kind, target_id)
  );

  -- Source message <-> board message. board_message_id NULL means a moderator
  -- deleted the board post: remember that so it is not reposted.
  CREATE TABLE board_posts (
    guild_id          TEXT NOT NULL,
    kind              TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    board_channel_id  TEXT NOT NULL,
    board_message_id  TEXT,
    count             INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, source_message_id)
  );
  CREATE INDEX board_posts_board_message ON board_posts (board_message_id);
`
);

// ---------------------------------------------------------------- caches

/** guildId -> { starboard: settings, clownboard: settings } (engine.resolveSettings). */
const settings = guildCache((guildId) => {
  const rows = db.all("SELECT * FROM boards WHERE guild_id = ?", guildId);
  const ignores = db.all("SELECT kind, target_id, target_kind FROM board_ignores WHERE guild_id = ?", guildId);
  const out = {};
  for (const kind of engine.KIND_NAMES)
    out[kind] = engine.resolveSettings(kind, rows.find((r) => r.kind === kind), ignores.filter((r) => r.kind === kind));
  return out;
});

/**
 * guildId -> { bySource: Map(sourceId -> rows[]), byBoard: Map(boardMessageId -> row) }.
 * Lets messageUpdate / messageDelete skip the database for messages that
 * were never posted (almost all of them).
 */
const posts = guildCache((guildId) => {
  const bySource = new Map();
  const byBoard = new Map();
  for (const row of db.all("SELECT * FROM board_posts WHERE guild_id = ?", guildId)) {
    if (!bySource.has(row.source_message_id)) bySource.set(row.source_message_id, []);
    bySource.get(row.source_message_id).push(row);
    if (row.board_message_id) byBoard.set(row.board_message_id, row);
  }
  return { bySource, byBoard };
});

// ---------------------------------------------------------------- settings

/** Columns the commands may write (keeps column names out of user input). */
const COLUMNS = ["channel_id", "emoji", "color", "threshold", "selfstar", "attachments", "jumpurl", "timestamp", "locked"];
/** `/<board> clear` choice -> column. */
const CLEAR_COLUMN = { emoji: "emoji", color: "color", channel: "channel_id", threshold: "threshold", selfstar: "selfstar", attachments: "attachments", jumpurl: "jumpurl", timestamp: "timestamp" };

const getBoard = (guildId, kind) => db.get("SELECT * FROM boards WHERE guild_id = ? AND kind = ?", guildId, kind);

/** Creates the row if needed, then sets the given columns. */
function setBoard(guildId, kind, fields) {
  db.transaction(() => {
    db.run("INSERT OR IGNORE INTO boards (guild_id, kind) VALUES (?, ?)", guildId, kind);
    for (const [column, value] of Object.entries(fields)) {
      if (!COLUMNS.includes(column)) throw new Error(`boards: unknown column ${column}`);
      db.run(`UPDATE boards SET ${column} = ? WHERE guild_id = ? AND kind = ?`, value, guildId, kind);
    }
  });
  settings.invalidate(guildId);
}

/** Resets one setting to its default (NULL). */
function clearSetting(guildId, kind, setting) {
  const column = CLEAR_COLUMN[setting];
  if (!column) throw new Error(`boards: unknown setting ${setting}`);
  db.run(`UPDATE boards SET ${column} = NULL WHERE guild_id = ? AND kind = ?`, guildId, kind);
  settings.invalidate(guildId);
}

/** Deletes the configuration and ignore list. Existing board posts are kept (and their mapping). */
function resetBoard(guildId, kind) {
  db.transaction(() => {
    db.run("DELETE FROM boards WHERE guild_id = ? AND kind = ?", guildId, kind);
    db.run("DELETE FROM board_ignores WHERE guild_id = ? AND kind = ?", guildId, kind);
  });
  settings.invalidate(guildId);
}

/** Adds the ignore if missing, removes it if present. Returns true when now ignored. */
function toggleIgnore(guildId, kind, targetId, targetKind) {
  const removed = db.run("DELETE FROM board_ignores WHERE guild_id = ? AND kind = ? AND target_id = ?", guildId, kind, targetId).changes;
  if (!removed)
    db.run("INSERT INTO board_ignores (guild_id, kind, target_id, target_kind) VALUES (?, ?, ?, ?)", guildId, kind, targetId, targetKind);
  settings.invalidate(guildId);
  return !removed;
}

const listIgnores = (guildId, kind) =>
  db.all("SELECT target_id, target_kind FROM board_ignores WHERE guild_id = ? AND kind = ? ORDER BY target_kind, target_id", guildId, kind);

// ---------------------------------------------------------------- posts

const getPost = (guildId, kind, sourceId) =>
  db.get("SELECT * FROM board_posts WHERE guild_id = ? AND kind = ? AND source_message_id = ?", guildId, kind, sourceId);

function savePost(row) {
  db.run(
    `INSERT OR REPLACE INTO board_posts
       (guild_id, kind, source_message_id, source_channel_id, board_channel_id, board_message_id, count, created_at)
     VALUES (:guild_id, :kind, :source_message_id, :source_channel_id, :board_channel_id, :board_message_id, :count, :created_at)`,
    { created_at: Date.now(), ...row }
  );
  posts.invalidate(row.guild_id);
}

function updateCount(guildId, kind, sourceId, count) {
  db.run("UPDATE board_posts SET count = ? WHERE guild_id = ? AND kind = ? AND source_message_id = ?", count, guildId, kind, sourceId);
  // count isn't read from the posts cache, so no invalidation needed.
}

function deletePost(guildId, kind, sourceId) {
  db.run("DELETE FROM board_posts WHERE guild_id = ? AND kind = ? AND source_message_id = ?", guildId, kind, sourceId);
  posts.invalidate(guildId);
}

/** A moderator deleted a board post: keep the row but forget the message, so it isn't reposted. */
function suppressPost(guildId, boardMessageId) {
  db.run("UPDATE board_posts SET board_message_id = NULL WHERE guild_id = ? AND board_message_id = ?", guildId, boardMessageId);
  posts.invalidate(guildId);
}

const countPosts = (guildId, kind) =>
  db.get("SELECT COUNT(*) AS n FROM board_posts WHERE guild_id = ? AND kind = ? AND board_message_id IS NOT NULL", guildId, kind).n;

module.exports = {
  settings,
  posts,
  CLEAR_COLUMN,
  getBoard,
  setBoard,
  clearSetting,
  resetBoard,
  toggleIgnore,
  listIgnores,
  getPost,
  savePost,
  updateCount,
  deletePost,
  suppressPost,
  countPosts,
};
