/**
 * SQLite database (Node's built-in node:sqlite, so no native dependency).
 *
 * The file is data/bot.db (DATA_DIR overrides the folder, like utils/store.js).
 * node:sqlite is synchronous: queries block the event loop for microseconds,
 * which is fine for a bot this size and keeps the code simple.
 *
 * Schema changes are named migrations. Each one runs once, inside a
 * transaction, and is recorded in the `migrations` table:
 *
 *   db.migrate("levels_001_init", `CREATE TABLE ...;`);
 *
 * Name them "<feature>_<nnn>_<what>" and never edit one that has shipped;
 * add a new migration instead.
 */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const file = process.env.DB_FILE || path.join(DATA_DIR, "bot.db");
const sqlite = new DatabaseSync(file);
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
`);

/** Prepared statements are cached by their SQL text. */
const statements = new Map();
function prepare(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    statement = sqlite.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

// Rows from node:sqlite have a null prototype; spread them into plain objects
// so they behave normally (e.g. in JSON or `in` checks).
const plain = (row) => (row ? { ...row } : row);

/**
 * Parameters can be positional (`?`) or named (`:name` / `$name` / `@name`).
 * Booleans become 0/1 and undefined becomes NULL, which SQLite expects.
 */
function normalise(params) {
  const fix = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  if (params.length === 1 && params[0] && typeof params[0] === "object" && !Array.isArray(params[0]) && !Buffer.isBuffer(params[0])) {
    const named = {};
    for (const [k, v] of Object.entries(params[0])) named[k] = fix(v);
    return [named];
  }
  return params.map(fix);
}

const db = {
  file,

  /** All rows. */
  all: (sql, ...params) => prepare(sql).all(...normalise(params)).map(plain),

  /** First row or undefined. */
  get: (sql, ...params) => plain(prepare(sql).get(...normalise(params))),

  /** INSERT / UPDATE / DELETE. Returns { changes, lastInsertRowid }. */
  run: (sql, ...params) => prepare(sql).run(...normalise(params)),

  /** Raw multi-statement SQL (no parameters). */
  exec: (sql) => sqlite.exec(sql),

  /**
   * Runs fn inside a transaction. Nested calls join the outer transaction.
   * fn must be synchronous (node:sqlite is), so do Discord calls outside it.
   */
  transaction(fn) {
    if (sqlite.isTransaction) return fn();
    sqlite.exec("BEGIN");
    try {
      const result = fn();
      sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
  },

  /** Runs `sql` once, ever, under `name`. Safe to call on every start. */
  migrate(name, sql) {
    if (db.get("SELECT 1 FROM migrations WHERE name = ?", name)) return false;
    db.transaction(() => {
      sqlite.exec(sql);
      db.run("INSERT INTO migrations (name, applied_at) VALUES (?, ?)", name, Date.now());
    });
    return true;
  },

  close: () => sqlite.close(),
};

// ---------------------------------------------------------------- core tables
// Tables read by the core services (guard, access middleware, scheduler,
// punishment service). Feature packages own their other tables.
db.migrate(
  "core_001_init",
  `
  -- Single-valued per-guild settings (key -> JSON value). See core/config.js.
  CREATE TABLE guild_config (
    guild_id TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  );

  -- /settings staff: roles that pass the "Staff Only" gate.
  CREATE TABLE staff_roles (
    guild_id TEXT NOT NULL,
    role_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  -- /access fakepermissions: bot-only permissions granted to a role.
  CREATE TABLE fake_permissions (
    guild_id   TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    permission TEXT NOT NULL,           -- PermissionFlagsBits key, e.g. "ManageGuild"
    PRIMARY KEY (guild_id, role_id, permission)
  );

  -- /ignore: type is 'member' or 'channel'.
  CREATE TABLE ignores (
    guild_id  TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type      TEXT NOT NULL CHECK (type IN ('member', 'channel')),
    PRIMARY KEY (guild_id, target_id)
  );

  -- /access command: '' (empty string) in channel_id / member_id means "not scoped".
  -- A row with both empty disables the command everywhere.
  CREATE TABLE disabled_commands (
    guild_id   TEXT NOT NULL,
    command    TEXT NOT NULL,           -- "levels rank", or a whole command "levels"
    channel_id TEXT NOT NULL DEFAULT '',
    member_id  TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (guild_id, command, channel_id, member_id)
  );

  -- /access module + /access event: channel_id '' = every channel.
  CREATE TABLE disabled_modules (
    guild_id   TEXT NOT NULL,
    module     TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (guild_id, module, channel_id)
  );
  CREATE TABLE disabled_events (
    guild_id   TEXT NOT NULL,
    event      TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (guild_id, event, channel_id)
  );

  -- core/scheduler.js: persistent timers that survive restarts.
  CREATE TABLE scheduled_jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    guild_id   TEXT,
    key        TEXT,                    -- optional dedupe key, unique per kind
    run_at     INTEGER NOT NULL,        -- unix ms
    payload    TEXT NOT NULL DEFAULT '{}',
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX scheduled_jobs_due ON scheduled_jobs (run_at);
  CREATE UNIQUE INDEX scheduled_jobs_key ON scheduled_jobs (kind, key) WHERE key IS NOT NULL;

  -- core/punish.js
  CREATE TABLE cases (
    guild_id     TEXT NOT NULL,
    case_id      INTEGER NOT NULL,
    user_id      TEXT NOT NULL,
    moderator_id TEXT,
    action       TEXT NOT NULL,
    reason       TEXT,
    duration_ms  INTEGER,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, case_id)
  );
  -- /invoke: custom DM / channel message per punishment. target = 'dm' | 'channel'.
  CREATE TABLE invoke_messages (
    guild_id   TEXT NOT NULL,
    punishment TEXT NOT NULL,
    target     TEXT NOT NULL CHECK (target IN ('dm', 'channel')),
    script     TEXT NOT NULL,
    PRIMARY KEY (guild_id, punishment, target)
  );
  -- Roles taken from a jailed member (settings jailroles = true), restored on unjail.
  CREATE TABLE jail_saved_roles (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    role_ids TEXT NOT NULL,             -- JSON array
    PRIMARY KEY (guild_id, user_id)
  );
`
);

module.exports = db;
