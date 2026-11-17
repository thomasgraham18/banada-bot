/**
 * Data for /autorole: join roles, reaction roles, button roles and dropdown
 * role menus. Every table is prefixed `autorole_`.
 *
 * Listeners never query these tables directly: they read `state.get(guildId)`
 * (a guildCache), and every write below invalidates it.
 */
const { db, config, guildCache } = require("../../core");

db.migrate(
  "autorole_001_init",
  `
  -- /autorole add: roles given to every new member.
  CREATE TABLE autorole_join (
    guild_id TEXT NOT NULL,
    role_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  -- /autorole reactionrole: emoji_key is parse.emojiKey() (custom emoji ID, or
  -- the unicode emoji without variation selectors); emoji is how to display it.
  CREATE TABLE autorole_reaction (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    emoji_key  TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    PRIMARY KEY (message_id, emoji_key)
  );
  CREATE INDEX autorole_reaction_guild ON autorole_reaction (guild_id);

  -- Reaction roles a member holds, given back on rejoin when restore is on.
  CREATE TABLE autorole_reaction_history (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    role_id  TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, role_id)
  );

  -- /autorole buttonrole: idx is the 1-based button position (5 per row).
  CREATE TABLE autorole_button (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    role_id    TEXT NOT NULL,
    label      TEXT,
    emoji      TEXT,
    style      INTEGER NOT NULL DEFAULT 1,  -- discord.js ButtonStyle
    PRIMARY KEY (message_id, idx),
    UNIQUE (message_id, role_id)
  );
  CREATE INDEX autorole_button_guild ON autorole_button (guild_id);

  -- /autorole dropdownrole: one row per menu message. max_values NULL = every option.
  CREATE TABLE autorole_dropdown (
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    message_id  TEXT PRIMARY KEY,
    placeholder TEXT,
    min_values  INTEGER NOT NULL DEFAULT 0,
    max_values  INTEGER,
    exclusive   INTEGER NOT NULL DEFAULT 0,
    script      TEXT
  );
  CREATE INDEX autorole_dropdown_guild ON autorole_dropdown (guild_id);

  CREATE TABLE autorole_dropdown_option (
    message_id  TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    role_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    emoji       TEXT,
    description TEXT,
    PRIMARY KEY (message_id, idx),
    UNIQUE (message_id, role_id)
  );

  -- /autorole <kind> required: kind = 'reaction' | 'button' | 'dropdown'.
  -- A member needs ANY one of these roles to use that message's roles.
  CREATE TABLE autorole_required (
    guild_id   TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('reaction', 'button', 'dropdown')),
    role_id    TEXT NOT NULL,
    PRIMARY KEY (message_id, kind, role_id)
  );
`
);

// Reaction-role groups: messages that share a group_name act as one menu.
//   exclusive       a member keeps one role from the whole group (picking another swaps it)
//   remove_unknown  reactions that aren't an option are taken off
//   managed_by      'panel' = written by the web panel's menu builder
//                   (utils/reactionRoles.js); /autorole commands leave those alone
db.migrate(
  "autorole_002_reaction_groups",
  `
  CREATE TABLE autorole_reaction_group (
    guild_id       TEXT NOT NULL,
    message_id     TEXT PRIMARY KEY,
    group_name     TEXT NOT NULL,
    exclusive      INTEGER NOT NULL DEFAULT 0,
    remove_unknown INTEGER NOT NULL DEFAULT 0,
    managed_by     TEXT
  );
  CREATE INDEX autorole_reaction_group_guild ON autorole_reaction_group (guild_id, group_name);
`
);

const RESTORE_KEY = "autorole_reaction_restore";

// ---------------------------------------------------------------- cache

/**
 * Everything the listeners need for one guild:
 *   join       role IDs for new members
 *   reactions  messageId -> Map(emojiKey -> roleId)
 *   buttons    messageId -> button rows sorted by idx
 *   menus      messageId -> { ...menu, options: [...] }
 *   required   "kind:messageId" -> Set(roleId)
 *   messages   every message ID we own (for messageDelete cleanup)
 *   channels   reaction messageId -> channelId
 *   groups     reaction messageId -> { group_name, exclusive, remove_unknown, managed_by }
 *   groupMessages  group_name -> [messageId]
 */
const state = guildCache((guildId) => {
  const s = {
    join: [], reactions: new Map(), buttons: new Map(), menus: new Map(), required: new Map(), messages: new Set(),
    channels: new Map(), groups: new Map(), groupMessages: new Map(),
  };
  s.join = db.all("SELECT role_id FROM autorole_join WHERE guild_id = ?", guildId).map((r) => r.role_id);
  for (const r of db.all("SELECT * FROM autorole_reaction WHERE guild_id = ?", guildId)) {
    if (!s.reactions.has(r.message_id)) s.reactions.set(r.message_id, new Map());
    s.reactions.get(r.message_id).set(r.emoji_key, r.role_id);
    s.channels.set(r.message_id, r.channel_id);
    s.messages.add(r.message_id);
  }
  for (const g of db.all("SELECT * FROM autorole_reaction_group WHERE guild_id = ?", guildId)) {
    s.groups.set(g.message_id, { ...g, exclusive: Boolean(g.exclusive), remove_unknown: Boolean(g.remove_unknown) });
    if (!s.groupMessages.has(g.group_name)) s.groupMessages.set(g.group_name, []);
    s.groupMessages.get(g.group_name).push(g.message_id);
    s.messages.add(g.message_id);
  }
  for (const r of db.all("SELECT * FROM autorole_button WHERE guild_id = ? ORDER BY idx", guildId)) {
    if (!s.buttons.has(r.message_id)) s.buttons.set(r.message_id, []);
    s.buttons.get(r.message_id).push(r);
    s.messages.add(r.message_id);
  }
  for (const m of db.all("SELECT * FROM autorole_dropdown WHERE guild_id = ?", guildId)) {
    s.menus.set(m.message_id, { ...m, exclusive: Boolean(m.exclusive), options: [] });
    s.messages.add(m.message_id);
  }
  for (const o of db.all(
    `SELECT o.* FROM autorole_dropdown_option o JOIN autorole_dropdown d ON d.message_id = o.message_id
     WHERE d.guild_id = ? ORDER BY o.idx`,
    guildId
  ))
    s.menus.get(o.message_id)?.options.push(o);
  for (const r of db.all("SELECT * FROM autorole_required WHERE guild_id = ?", guildId)) {
    const key = `${r.kind}:${r.message_id}`;
    if (!s.required.has(key)) s.required.set(key, new Set());
    s.required.get(key).add(r.role_id);
  }
  return s;
});

/** Runs fn in a transaction, then drops the guild's cache. */
const write = (guildId, fn) => {
  const result = db.transaction(fn);
  state.invalidate(guildId);
  return result;
};

// ---------------------------------------------------------------- join roles

const join = {
  list: (guildId) => state.get(guildId).join,
  add: (guildId, roleId) =>
    write(guildId, () => db.run("INSERT OR IGNORE INTO autorole_join (guild_id, role_id) VALUES (?, ?)", guildId, roleId).changes > 0),
  remove: (guildId, roleId) =>
    write(guildId, () => db.run("DELETE FROM autorole_join WHERE guild_id = ? AND role_id = ?", guildId, roleId).changes > 0),
  reset: (guildId) => write(guildId, () => db.run("DELETE FROM autorole_join WHERE guild_id = ?", guildId).changes),
};

// ---------------------------------------------------------------- reaction roles

const reaction = {
  forMessage: (messageId) => db.all("SELECT * FROM autorole_reaction WHERE message_id = ?", messageId),
  all: (guildId) => db.all("SELECT * FROM autorole_reaction WHERE guild_id = ? ORDER BY channel_id, message_id", guildId),
  /** Inserts or replaces the role for this emoji on this message. */
  set: (row) =>
    write(row.guild_id, () =>
      db.run(
        `INSERT INTO autorole_reaction (guild_id, channel_id, message_id, emoji_key, emoji, role_id)
         VALUES (:guild_id, :channel_id, :message_id, :emoji_key, :emoji, :role_id)
         ON CONFLICT (message_id, emoji_key) DO UPDATE SET role_id = excluded.role_id, emoji = excluded.emoji`,
        row
      )
    ),
  remove: (guildId, messageId, emojiKey) =>
    write(guildId, () => db.run("DELETE FROM autorole_reaction WHERE guild_id = ? AND message_id = ? AND emoji_key = ?", guildId, messageId, emojiKey).changes > 0),
  removeAll: (guildId, messageId) =>
    write(guildId, () => {
      db.run("DELETE FROM autorole_required WHERE guild_id = ? AND message_id = ? AND kind = 'reaction'", guildId, messageId);
      return db.run("DELETE FROM autorole_reaction WHERE guild_id = ? AND message_id = ?", guildId, messageId).changes;
    }),
  /** Removes every /autorole reaction role. Menus managed by the web panel are left alone. */
  reset: (guildId) =>
    write(guildId, () => {
      const notManaged = "message_id NOT IN (SELECT message_id FROM autorole_reaction_group WHERE managed_by IS NOT NULL)";
      db.run(`DELETE FROM autorole_required WHERE guild_id = ? AND kind = 'reaction' AND ${notManaged}`, guildId);
      return db.run(`DELETE FROM autorole_reaction WHERE guild_id = ? AND ${notManaged}`, guildId).changes;
    }),

  restoreEnabled: (guildId) => Boolean(config.get(guildId, RESTORE_KEY, false)),
  setRestore: (guildId, on) => config.set(guildId, RESTORE_KEY, Boolean(on)),

  // History is only written from reaction listeners on our own messages, so a
  // query per write is fine there (it is not a per-message hot path).
  remember: (guildId, userId, roleId) =>
    db.run("INSERT OR IGNORE INTO autorole_reaction_history (guild_id, user_id, role_id) VALUES (?, ?, ?)", guildId, userId, roleId),
  forget: (guildId, userId, roleId) =>
    db.run("DELETE FROM autorole_reaction_history WHERE guild_id = ? AND user_id = ? AND role_id = ?", guildId, userId, roleId),
  history: (guildId, userId) =>
    db.all("SELECT role_id FROM autorole_reaction_history WHERE guild_id = ? AND user_id = ?", guildId, userId).map((r) => r.role_id),
};

// ---------------------------------------------------------------- button roles

const button = {
  forMessage: (guildId, messageId) => state.get(guildId).buttons.get(messageId) ?? [],
  all: (guildId) => db.all("SELECT * FROM autorole_button WHERE guild_id = ? ORDER BY channel_id, message_id, idx", guildId),
  /** Replaces a message's buttons with `rows` (already renumbered 1..n). */
  replace: (guildId, messageId, rows) =>
    write(guildId, () => {
      db.run("DELETE FROM autorole_button WHERE guild_id = ? AND message_id = ?", guildId, messageId);
      for (const r of rows)
        db.run(
          `INSERT INTO autorole_button (guild_id, channel_id, message_id, idx, role_id, label, emoji, style)
           VALUES (:guild_id, :channel_id, :message_id, :idx, :role_id, :label, :emoji, :style)`,
          { guild_id: guildId, message_id: messageId, channel_id: r.channel_id, idx: r.idx, role_id: r.role_id, label: r.label, emoji: r.emoji, style: r.style }
        );
      if (!rows.length) db.run("DELETE FROM autorole_required WHERE guild_id = ? AND message_id = ? AND kind = 'button'", guildId, messageId);
    }),
  reset: (guildId) =>
    write(guildId, () => {
      db.run("DELETE FROM autorole_required WHERE guild_id = ? AND kind = 'button'", guildId);
      return db.run("DELETE FROM autorole_button WHERE guild_id = ?", guildId).changes;
    }),
};

// ---------------------------------------------------------------- dropdowns

const dropdown = {
  get: (guildId, messageId) => state.get(guildId).menus.get(messageId) ?? null,
  all: (guildId) => [...state.get(guildId).menus.values()],
  create: (guildId, channelId, messageId, option) =>
    write(guildId, () => {
      db.run("INSERT INTO autorole_dropdown (guild_id, channel_id, message_id) VALUES (?, ?, ?)", guildId, channelId, messageId);
      db.run(
        "INSERT INTO autorole_dropdown_option (message_id, idx, role_id, title) VALUES (?, 1, ?, ?)",
        messageId,
        option.role_id,
        option.title
      );
    }),
  /** Updates menu columns (placeholder, min_values, max_values, exclusive, script). */
  update: (guildId, messageId, fields) =>
    write(guildId, () => {
      const allowed = ["placeholder", "min_values", "max_values", "exclusive", "script"];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      db.run(
        `UPDATE autorole_dropdown SET ${keys.map((k) => `${k} = :${k}`).join(", ")} WHERE guild_id = :guild_id AND message_id = :message_id`,
        { ...Object.fromEntries(keys.map((k) => [k, fields[k]])), guild_id: guildId, message_id: messageId }
      );
    }),
  /** Replaces a menu's options with `options` (already renumbered 1..n). */
  replaceOptions: (guildId, messageId, options) =>
    write(guildId, () => {
      db.run("DELETE FROM autorole_dropdown_option WHERE message_id = ?", messageId);
      for (const o of options)
        db.run(
          "INSERT INTO autorole_dropdown_option (message_id, idx, role_id, title, emoji, description) VALUES (?, ?, ?, ?, ?, ?)",
          messageId,
          o.idx,
          o.role_id,
          o.title,
          o.emoji ?? null,
          o.description ?? null
        );
    }),
  remove: (guildId, messageId) =>
    write(guildId, () => {
      db.run("DELETE FROM autorole_dropdown_option WHERE message_id = ?", messageId);
      db.run("DELETE FROM autorole_required WHERE guild_id = ? AND message_id = ? AND kind = 'dropdown'", guildId, messageId);
      return db.run("DELETE FROM autorole_dropdown WHERE guild_id = ? AND message_id = ?", guildId, messageId).changes > 0;
    }),
};

// ---------------------------------------------------------------- required roles

const required = {
  get: (guildId, kind, messageId) => state.get(guildId).required.get(`${kind}:${messageId}`) ?? new Set(),
  set: (guildId, kind, messageId, roleIds) =>
    write(guildId, () => {
      db.run("DELETE FROM autorole_required WHERE guild_id = ? AND message_id = ? AND kind = ?", guildId, messageId, kind);
      for (const id of new Set(roleIds))
        db.run("INSERT INTO autorole_required (guild_id, message_id, kind, role_id) VALUES (?, ?, ?, ?)", guildId, messageId, kind, id);
    }),
};

// ---------------------------------------------------------------- reaction groups

const groups = {
  get: (guildId, messageId) => state.get(guildId).groups.get(messageId) ?? null,
  /** Who manages a message's reaction roles ('panel'), or null for /autorole's own. */
  managedBy: (guildId, messageId) => state.get(guildId).groups.get(messageId)?.managed_by ?? null,

  /**
   * Replaces every reaction-role message owned by `managedBy` in a guild with
   * `menus`, in one transaction. Used by the web panel's menu builder.
   *   menus: [{ messageId, channelId, group, exclusive, removeUnknown, required: [roleId],
   *             options: [{ emojiKey, emoji, roleId }] }]
   * Member reaction history is kept, so restore-on-rejoin keeps working.
   */
  syncManaged(guildId, managedBy, menus) {
    return write(guildId, () => {
      const old = db.all("SELECT message_id FROM autorole_reaction_group WHERE guild_id = ? AND managed_by = ?", guildId, managedBy);
      for (const { message_id } of old) {
        db.run("DELETE FROM autorole_reaction WHERE guild_id = ? AND message_id = ?", guildId, message_id);
        db.run("DELETE FROM autorole_required WHERE guild_id = ? AND message_id = ? AND kind = 'reaction'", guildId, message_id);
        db.run("DELETE FROM autorole_reaction_group WHERE message_id = ?", message_id);
      }
      for (const m of menus) {
        // Never take over a message that /autorole itself manages.
        const owner = db.get("SELECT managed_by FROM autorole_reaction_group WHERE message_id = ?", m.messageId);
        if (owner || db.get("SELECT 1 FROM autorole_reaction WHERE message_id = ?", m.messageId)) continue;
        db.run(
          `INSERT INTO autorole_reaction_group (guild_id, message_id, group_name, exclusive, remove_unknown, managed_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          guildId, m.messageId, m.group, m.exclusive, m.removeUnknown, managedBy
        );
        for (const o of m.options)
          db.run(
            `INSERT OR REPLACE INTO autorole_reaction (guild_id, channel_id, message_id, emoji_key, emoji, role_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            guildId, m.channelId, m.messageId, o.emojiKey, o.emoji, o.roleId
          );
        for (const roleId of new Set(m.required ?? []))
          db.run("INSERT INTO autorole_required (guild_id, message_id, kind, role_id) VALUES (?, ?, 'reaction', ?)", guildId, m.messageId, roleId);
      }
      return menus.length;
    });
  },
};

// ---------------------------------------------------------------- cleanup

/** A message we own was deleted: forget everything attached to it. */
const forgetMessage = (guildId, messageId) =>
  write(guildId, () => {
    db.run("DELETE FROM autorole_reaction_group WHERE guild_id = ? AND message_id = ?", guildId, messageId);
    db.run("DELETE FROM autorole_reaction WHERE guild_id = ? AND message_id = ?", guildId, messageId);
    db.run("DELETE FROM autorole_button WHERE guild_id = ? AND message_id = ?", guildId, messageId);
    db.run("DELETE FROM autorole_dropdown_option WHERE message_id = ?", messageId);
    db.run("DELETE FROM autorole_dropdown WHERE guild_id = ? AND message_id = ?", guildId, messageId);
    db.run("DELETE FROM autorole_required WHERE guild_id = ? AND message_id = ?", guildId, messageId);
  });

/**
 * A role was deleted: drop it everywhere. Returns [{ messageId, channelId }]
 * for messages whose buttons/dropdown changed, so the caller can redraw them.
 */
function forgetRole(guildId, roleId) {
  const channels = new Map(); // messageId -> channelId
  for (const r of db.all("SELECT message_id, channel_id FROM autorole_button WHERE guild_id = ? AND role_id = ?", guildId, roleId))
    channels.set(r.message_id, r.channel_id);
  for (const r of db.all(
    `SELECT o.message_id, d.channel_id FROM autorole_dropdown_option o JOIN autorole_dropdown d ON d.message_id = o.message_id
     WHERE d.guild_id = ? AND o.role_id = ?`,
    guildId,
    roleId
  ))
    channels.set(r.message_id, r.channel_id);
  const touched = [...channels.keys()];
  write(guildId, () => {
    db.run("DELETE FROM autorole_join WHERE guild_id = ? AND role_id = ?", guildId, roleId);
    db.run("DELETE FROM autorole_reaction WHERE guild_id = ? AND role_id = ?", guildId, roleId);
    db.run("DELETE FROM autorole_reaction_history WHERE guild_id = ? AND role_id = ?", guildId, roleId);
    db.run("DELETE FROM autorole_required WHERE guild_id = ? AND role_id = ?", guildId, roleId);
    for (const messageId of touched) {
      const buttons = db.all("SELECT * FROM autorole_button WHERE message_id = ? AND role_id != ? ORDER BY idx", messageId, roleId);
      db.run("DELETE FROM autorole_button WHERE message_id = ?", messageId);
      buttons.forEach((b, i) =>
        db.run(
          `INSERT INTO autorole_button (guild_id, channel_id, message_id, idx, role_id, label, emoji, style)
           VALUES (:guild_id, :channel_id, :message_id, :idx, :role_id, :label, :emoji, :style)`,
          { ...b, idx: i + 1 }
        )
      );
      const options = db.all("SELECT * FROM autorole_dropdown_option WHERE message_id = ? AND role_id != ? ORDER BY idx", messageId, roleId);
      db.run("DELETE FROM autorole_dropdown_option WHERE message_id = ?", messageId);
      options.forEach((o, i) =>
        db.run(
          "INSERT INTO autorole_dropdown_option (message_id, idx, role_id, title, emoji, description) VALUES (?, ?, ?, ?, ?, ?)",
          messageId, i + 1, o.role_id, o.title, o.emoji, o.description
        )
      );
      // A select menu needs at least one option: a menu that lost its last role goes away.
      if (!options.length && db.get("SELECT 1 FROM autorole_dropdown WHERE message_id = ?", messageId)) {
        db.run("DELETE FROM autorole_required WHERE message_id = ? AND kind = 'dropdown'", messageId);
        db.run("DELETE FROM autorole_dropdown WHERE message_id = ?", messageId);
      }
    }
  });
  return [...channels].map(([messageId, channelId]) => ({ messageId, channelId }));
}

module.exports = { state, join, reaction, button, dropdown, required, groups, forgetMessage, forgetRole, RESTORE_KEY };
