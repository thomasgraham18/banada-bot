/**
 * Tables, queries and listener caches for /autoresponder and /reaction.
 *
 * Every write goes through a function in this file, and every write
 * invalidates the guild's cache, so the listeners (which only ever read the
 * caches) can never see stale data.
 */
const { db, guildCache } = require("../../core");
const matcher = require("./matcher");

db.migrate(
  "autoresponder_001_init",
  `
  -- /autoresponder add|update. trigger is normalised (matcher.cleanTrigger).
  CREATE TABLE autoresponder_triggers (
    guild_id             TEXT NOT NULL,
    trigger              TEXT NOT NULL,
    script               TEXT NOT NULL,         -- core message script
    self_destruct        INTEGER,               -- seconds, NULL = keep the reply
    strict               INTEGER NOT NULL DEFAULT 0,
    ignore_command_check INTEGER NOT NULL DEFAULT 0,
    delete_message       INTEGER NOT NULL DEFAULT 0,  -- delete the triggering message
    reply                INTEGER NOT NULL DEFAULT 0,
    ticket_form          INTEGER NOT NULL DEFAULT 0,  -- stored flag only (tickets are out of scope)
    creator_id           TEXT,
    created_at           INTEGER NOT NULL,
    PRIMARY KEY (guild_id, trigger)
  );

  -- /autoresponder role add|remove: roles given/taken when a trigger fires.
  CREATE TABLE autoresponder_roles (
    guild_id TEXT NOT NULL,
    trigger  TEXT NOT NULL,
    role_id  TEXT NOT NULL,
    action   TEXT NOT NULL CHECK (action IN ('add', 'remove')),
    PRIMARY KEY (guild_id, trigger, role_id, action)
  );

  -- /autoresponder exclusive: limits a trigger to roles and/or channels.
  CREATE TABLE autoresponder_exclusive (
    guild_id  TEXT NOT NULL,
    trigger   TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('role', 'channel')),
    PRIMARY KEY (guild_id, trigger, target_id)
  );

  -- /reaction add (kind 'normal') and /reaction previousreact add (kind 'previous').
  CREATE TABLE autoresponder_reactions (
    guild_id   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('normal', 'previous')),
    trigger    TEXT NOT NULL,
    emoji_key  TEXT NOT NULL,               -- parse.emojiKey(): id or unicode, for comparisons
    emoji      TEXT NOT NULL,               -- how to display it
    identifier TEXT NOT NULL,               -- what message.react() takes
    creator_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, trigger, emoji_key)
  );

  -- /reaction messages set: react to every message in a channel.
  CREATE TABLE autoresponder_channel_reactions (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    emojis     TEXT NOT NULL,               -- JSON [{ text, identifier }]
    PRIMARY KEY (guild_id, channel_id)
  );

  -- /reaction noselfreact
  CREATE TABLE autoresponder_noselfreact (
    guild_id     TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    bypass_staff INTEGER NOT NULL DEFAULT 0,
    punishment   TEXT NOT NULL DEFAULT 'none'
  );
  CREATE TABLE autoresponder_noselfreact_emojis (
    guild_id  TEXT NOT NULL,
    emoji_key TEXT NOT NULL,
    emoji     TEXT NOT NULL,
    PRIMARY KEY (guild_id, emoji_key)
  );
  CREATE TABLE autoresponder_noselfreact_exempt (
    guild_id  TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('member', 'role', 'channel')),
    PRIMARY KEY (guild_id, target_id)
  );
`
);

/** Limits that keep the per-guild regexes and reaction bursts reasonable. */
const LIMITS = {
  autoresponders: 250,
  reactionTriggers: 300, // rows (trigger + emoji) per kind
  emojisPerTrigger: 10,
  reactionsPerMessage: 20, // Discord's cap on distinct reactions per message
};

// ---------------------------------------------------------------- caches

/**
 * guildId -> { matcher, count }. Each matcher entry is an autoresponder row
 * with its role actions and exclusive targets pre-grouped:
 *   { ...row, addRoles: [ids], removeRoles: [ids], exclusiveRoles: Set, exclusiveChannels: Set }
 */
const autoresponderCache = guildCache((guildId) => {
  const rows = db.all("SELECT * FROM autoresponder_triggers WHERE guild_id = ?", guildId);
  if (!rows.length) return { matcher: matcher.compile([]), count: 0 };
  const byTrigger = new Map();
  for (const row of rows) {
    byTrigger.set(row.trigger, {
      ...row,
      strict: Boolean(row.strict),
      addRoles: [],
      removeRoles: [],
      exclusiveRoles: new Set(),
      exclusiveChannels: new Set(),
    });
  }
  for (const r of db.all("SELECT trigger, role_id, action FROM autoresponder_roles WHERE guild_id = ?", guildId))
    byTrigger.get(r.trigger)?.[r.action === "add" ? "addRoles" : "removeRoles"].push(r.role_id);
  for (const r of db.all("SELECT trigger, target_id, kind FROM autoresponder_exclusive WHERE guild_id = ?", guildId))
    byTrigger.get(r.trigger)?.[r.kind === "role" ? "exclusiveRoles" : "exclusiveChannels"].add(r.target_id);
  return { matcher: matcher.compile([...byTrigger.values()]), count: rows.length };
});

/**
 * guildId -> { normal, previous }: one matcher per kind. Entries are
 * { trigger, emojis: [identifier] }, one per trigger.
 */
const reactionCache = guildCache((guildId) => {
  const groups = { normal: new Map(), previous: new Map() };
  for (const r of db.all("SELECT kind, trigger, identifier FROM autoresponder_reactions WHERE guild_id = ? ORDER BY created_at", guildId)) {
    const map = groups[r.kind];
    if (!map.has(r.trigger)) map.set(r.trigger, { trigger: r.trigger, emojis: [] });
    map.get(r.trigger).emojis.push(r.identifier);
  }
  return {
    normal: matcher.compile([...groups.normal.values()]),
    previous: matcher.compile([...groups.previous.values()]),
  };
});

/** guildId -> Map(channelId -> [identifier]) */
const channelReactionCache = guildCache((guildId) => {
  const map = new Map();
  for (const r of db.all("SELECT channel_id, emojis FROM autoresponder_channel_reactions WHERE guild_id = ?", guildId))
    map.set(r.channel_id, JSON.parse(r.emojis).map((e) => e.identifier));
  return map;
});

/** guildId -> { enabled, bypassStaff, punishment, emojis: Set(key), exempt: Set(id) } */
const noSelfReactCache = guildCache((guildId) => {
  const row = getNoSelfReact(guildId);
  return {
    enabled: row.enabled,
    bypassStaff: row.bypass_staff,
    punishment: row.punishment,
    emojis: new Set(db.all("SELECT emoji_key FROM autoresponder_noselfreact_emojis WHERE guild_id = ?", guildId).map((r) => r.emoji_key)),
    exempt: new Set(db.all("SELECT target_id FROM autoresponder_noselfreact_exempt WHERE guild_id = ?", guildId).map((r) => r.target_id)),
  };
});

// ---------------------------------------------------------------- autoresponders

const getAutoresponder = (guildId, trigger) =>
  db.get("SELECT * FROM autoresponder_triggers WHERE guild_id = ? AND trigger = ?", guildId, trigger);

const listAutoresponders = (guildId, { ticketsOnly = false } = {}) =>
  db.all(
    `SELECT * FROM autoresponder_triggers WHERE guild_id = ? ${ticketsOnly ? "AND ticket_form = 1" : ""} ORDER BY trigger`,
    guildId
  );

const countAutoresponders = (guildId) =>
  db.get("SELECT COUNT(*) AS n FROM autoresponder_triggers WHERE guild_id = ?", guildId).n;

/** Inserts or updates every column given in `row` (the trigger is the key). */
function saveAutoresponder(guildId, row) {
  db.run(
    `INSERT INTO autoresponder_triggers
       (guild_id, trigger, script, self_destruct, strict, ignore_command_check, delete_message, reply, ticket_form, creator_id, created_at)
     VALUES (:guild_id, :trigger, :script, :self_destruct, :strict, :ignore_command_check, :delete_message, :reply, :ticket_form, :creator_id, :created_at)
     ON CONFLICT (guild_id, trigger) DO UPDATE SET
       script = excluded.script, self_destruct = excluded.self_destruct, strict = excluded.strict,
       ignore_command_check = excluded.ignore_command_check, delete_message = excluded.delete_message,
       reply = excluded.reply, ticket_form = excluded.ticket_form`,
    {
      guild_id: guildId,
      trigger: row.trigger,
      script: row.script,
      self_destruct: row.self_destruct ?? null,
      strict: Boolean(row.strict),
      ignore_command_check: Boolean(row.ignore_command_check),
      delete_message: Boolean(row.delete_message),
      reply: Boolean(row.reply),
      ticket_form: Boolean(row.ticket_form),
      creator_id: row.creator_id ?? null,
      created_at: row.created_at ?? Date.now(),
    }
  );
  autoresponderCache.invalidate(guildId);
}

/** Removes a trigger with its roles and exclusive rows. Returns true if it existed. */
function removeAutoresponder(guildId, trigger) {
  const changes = db.transaction(() => {
    db.run("DELETE FROM autoresponder_roles WHERE guild_id = ? AND trigger = ?", guildId, trigger);
    db.run("DELETE FROM autoresponder_exclusive WHERE guild_id = ? AND trigger = ?", guildId, trigger);
    return db.run("DELETE FROM autoresponder_triggers WHERE guild_id = ? AND trigger = ?", guildId, trigger).changes;
  });
  autoresponderCache.invalidate(guildId);
  return changes > 0;
}

/** Removes every autoresponder. Returns how many there were. */
function resetAutoresponders(guildId) {
  const changes = db.transaction(() => {
    db.run("DELETE FROM autoresponder_roles WHERE guild_id = ?", guildId);
    db.run("DELETE FROM autoresponder_exclusive WHERE guild_id = ?", guildId);
    return db.run("DELETE FROM autoresponder_triggers WHERE guild_id = ?", guildId).changes;
  });
  autoresponderCache.invalidate(guildId);
  return changes;
}

/** enabled=true adds the role action, false removes it. Returns true if anything changed. */
function setTriggerRole(guildId, trigger, roleId, action, enabled) {
  const result = enabled
    ? db.run("INSERT OR IGNORE INTO autoresponder_roles (guild_id, trigger, role_id, action) VALUES (?, ?, ?, ?)", guildId, trigger, roleId, action)
    : db.run("DELETE FROM autoresponder_roles WHERE guild_id = ? AND trigger = ? AND role_id = ? AND action = ?", guildId, trigger, roleId, action);
  autoresponderCache.invalidate(guildId);
  return result.changes > 0;
}

const listTriggerRoles = (guildId, trigger, action) =>
  db.all("SELECT role_id FROM autoresponder_roles WHERE guild_id = ? AND trigger = ? AND action = ?", guildId, trigger, action).map((r) => r.role_id);

/** Adds (enabled=true) or removes an exclusive role/channel. Returns true if anything changed. */
function setExclusive(guildId, trigger, targetId, kind, enabled) {
  const result = enabled
    ? db.run("INSERT OR IGNORE INTO autoresponder_exclusive (guild_id, trigger, target_id, kind) VALUES (?, ?, ?, ?)", guildId, trigger, targetId, kind)
    : db.run("DELETE FROM autoresponder_exclusive WHERE guild_id = ? AND trigger = ? AND target_id = ?", guildId, trigger, targetId);
  autoresponderCache.invalidate(guildId);
  return result.changes > 0;
}

const listExclusive = (guildId, trigger) =>
  db.all("SELECT target_id, kind FROM autoresponder_exclusive WHERE guild_id = ? AND trigger = ? ORDER BY kind", guildId, trigger);

// ---------------------------------------------------------------- reaction triggers

const listReactions = (guildId, kind, trigger) =>
  trigger === undefined
    ? db.all("SELECT * FROM autoresponder_reactions WHERE guild_id = ? AND kind = ? ORDER BY trigger, created_at", guildId, kind)
    : db.all("SELECT * FROM autoresponder_reactions WHERE guild_id = ? AND kind = ? AND trigger = ? ORDER BY created_at", guildId, kind, trigger);

const countReactions = (guildId, kind) =>
  db.get("SELECT COUNT(*) AS n FROM autoresponder_reactions WHERE guild_id = ? AND kind = ?", guildId, kind).n;

/** Returns false if that trigger already has that emoji. */
function addReaction(guildId, kind, trigger, emoji, creatorId) {
  const result = db.run(
    `INSERT OR IGNORE INTO autoresponder_reactions (guild_id, kind, trigger, emoji_key, emoji, identifier, creator_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    guildId, kind, trigger, emoji.key, emoji.text, emoji.identifier, creatorId, Date.now()
  );
  reactionCache.invalidate(guildId);
  return result.changes > 0;
}

/** emojiKey null = every emoji of the trigger; trigger null = everything of that kind. Returns rows removed. */
function removeReactions(guildId, kind, trigger = null, emojiKey = null) {
  let sql = "DELETE FROM autoresponder_reactions WHERE guild_id = ? AND kind = ?";
  const params = [guildId, kind];
  if (trigger !== null) {
    sql += " AND trigger = ?";
    params.push(trigger);
  }
  if (emojiKey !== null) {
    sql += " AND emoji_key = ?";
    params.push(emojiKey);
  }
  const { changes } = db.run(sql, ...params);
  reactionCache.invalidate(guildId);
  return changes;
}

/** Distinct triggers of a kind (for autocomplete). */
const reactionTriggers = (guildId, kind) =>
  db.all("SELECT DISTINCT trigger FROM autoresponder_reactions WHERE guild_id = ? AND kind = ? ORDER BY trigger", guildId, kind).map((r) => r.trigger);

// ---------------------------------------------------------------- channel auto reactions

function setChannelReactions(guildId, channelId, emojis) {
  db.run(
    `INSERT INTO autoresponder_channel_reactions (guild_id, channel_id, emojis) VALUES (?, ?, ?)
     ON CONFLICT (guild_id, channel_id) DO UPDATE SET emojis = excluded.emojis`,
    guildId, channelId, JSON.stringify(emojis.map((e) => ({ text: e.text, identifier: e.identifier })))
  );
  channelReactionCache.invalidate(guildId);
}

function removeChannelReactions(guildId, channelId) {
  const { changes } = db.run("DELETE FROM autoresponder_channel_reactions WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
  channelReactionCache.invalidate(guildId);
  return changes > 0;
}

const listChannelReactions = (guildId) =>
  db.all("SELECT channel_id, emojis FROM autoresponder_channel_reactions WHERE guild_id = ?", guildId)
    .map((r) => ({ channelId: r.channel_id, emojis: JSON.parse(r.emojis) }));

// ---------------------------------------------------------------- no self react

function getNoSelfReact(guildId) {
  const row = db.get("SELECT * FROM autoresponder_noselfreact WHERE guild_id = ?", guildId);
  return {
    enabled: Boolean(row?.enabled),
    bypass_staff: Boolean(row?.bypass_staff),
    punishment: row?.punishment ?? "none",
  };
}

/** Updates one or more of { enabled, bypass_staff, punishment }. */
function setNoSelfReact(guildId, changes) {
  const next = { ...getNoSelfReact(guildId), ...changes };
  db.run(
    `INSERT INTO autoresponder_noselfreact (guild_id, enabled, bypass_staff, punishment) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled, bypass_staff = excluded.bypass_staff, punishment = excluded.punishment`,
    guildId, next.enabled, next.bypass_staff, next.punishment
  );
  noSelfReactCache.invalidate(guildId);
  return next;
}

/** Adds the emoji if missing, removes it if present. Returns true when it was added. */
function toggleNoSelfReactEmoji(guildId, key, text) {
  const removed = db.run("DELETE FROM autoresponder_noselfreact_emojis WHERE guild_id = ? AND emoji_key = ?", guildId, key).changes;
  if (!removed) db.run("INSERT INTO autoresponder_noselfreact_emojis (guild_id, emoji_key, emoji) VALUES (?, ?, ?)", guildId, key, text);
  noSelfReactCache.invalidate(guildId);
  return !removed;
}

const listNoSelfReactEmojis = (guildId) =>
  db.all("SELECT emoji_key, emoji FROM autoresponder_noselfreact_emojis WHERE guild_id = ? ORDER BY emoji", guildId);

/** Adds the exemption if missing, removes it if present. Returns true when it was added. */
function toggleNoSelfReactExempt(guildId, targetId, kind) {
  const removed = db.run("DELETE FROM autoresponder_noselfreact_exempt WHERE guild_id = ? AND target_id = ?", guildId, targetId).changes;
  if (!removed) db.run("INSERT INTO autoresponder_noselfreact_exempt (guild_id, target_id, kind) VALUES (?, ?, ?)", guildId, targetId, kind);
  noSelfReactCache.invalidate(guildId);
  return !removed;
}

const listNoSelfReactExempt = (guildId) =>
  db.all("SELECT target_id, kind FROM autoresponder_noselfreact_exempt WHERE guild_id = ? ORDER BY kind", guildId);

// ---------------------------------------------------------------- cleanup
// Exclusive rows are deliberately NOT removed here: if a trigger was limited
// to one channel/role and that is deleted, dropping the row would suddenly
// let the trigger fire everywhere. A stale row just never matches.

/** Forgets a deleted channel (auto reactions, no-self-react exemptions). */
function forgetChannel(guildId, channelId) {
  db.transaction(() => {
    db.run("DELETE FROM autoresponder_channel_reactions WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    db.run("DELETE FROM autoresponder_noselfreact_exempt WHERE guild_id = ? AND target_id = ?", guildId, channelId);
  });
  channelReactionCache.invalidate(guildId);
  noSelfReactCache.invalidate(guildId);
}

/** Forgets a deleted role (role actions, no-self-react exemptions). */
function forgetRole(guildId, roleId) {
  db.transaction(() => {
    db.run("DELETE FROM autoresponder_roles WHERE guild_id = ? AND role_id = ?", guildId, roleId);
    db.run("DELETE FROM autoresponder_noselfreact_exempt WHERE guild_id = ? AND target_id = ?", guildId, roleId);
  });
  autoresponderCache.invalidate(guildId);
  noSelfReactCache.invalidate(guildId);
}

module.exports = {
  LIMITS,
  caches: { autoresponders: autoresponderCache, reactions: reactionCache, channelReactions: channelReactionCache, noSelfReact: noSelfReactCache },
  getAutoresponder,
  listAutoresponders,
  countAutoresponders,
  saveAutoresponder,
  removeAutoresponder,
  resetAutoresponders,
  setTriggerRole,
  listTriggerRoles,
  setExclusive,
  listExclusive,
  listReactions,
  countReactions,
  addReaction,
  removeReactions,
  reactionTriggers,
  setChannelReactions,
  removeChannelReactions,
  listChannelReactions,
  getNoSelfReact,
  setNoSelfReact,
  toggleNoSelfReactEmoji,
  listNoSelfReactEmojis,
  toggleNoSelfReactExempt,
  listNoSelfReactExempt,
  forgetChannel,
  forgetRole,
};
