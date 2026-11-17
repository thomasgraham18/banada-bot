/**
 * /config data: welcome/goodbye/boost messages, webhooks, sticky messages,
 * gallery channels and aliases. Every table is prefixed with "config_".
 *
 * Listeners never query these tables directly: they read the guildCache
 * objects at the bottom, and every write function here invalidates them.
 */
const { db, guildCache } = require("../../core");

db.migrate(
  "config_001_init",
  `
  -- One message per (guild, kind, channel). kind: welcome | goodbye | boost.
  CREATE TABLE config_join_messages (
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('welcome', 'goodbye', 'boost')),
    script        TEXT NOT NULL,
    self_destruct INTEGER,               -- seconds, NULL = keep the message
    pingable      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, channel_id)
  );

  -- Webhooks the bot created. The token is encrypted at rest (see crypto.js);
  -- it is never shown to anyone.
  CREATE TABLE config_webhooks (
    guild_id                TEXT NOT NULL,
    identifier              TEXT NOT NULL,
    webhook_id              TEXT NOT NULL,
    webhook_token_encrypted TEXT NOT NULL,
    channel_id              TEXT NOT NULL,
    name                    TEXT NOT NULL,
    creator_id              TEXT NOT NULL,
    locked                  INTEGER NOT NULL DEFAULT 0,
    created_at              INTEGER NOT NULL,
    PRIMARY KEY (guild_id, identifier)
  );
  CREATE INDEX config_webhooks_by_id ON config_webhooks (webhook_id);

  CREATE TABLE config_sticky_messages (
    guild_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL,
    script          TEXT NOT NULL,
    last_message_id TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE config_gallery_channels (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread     INTEGER NOT NULL DEFAULT 0, -- open a discussion thread under each image
    PRIMARY KEY (guild_id, channel_id)
  );

  -- Slash-only aliases: each one is a guild slash command /<shortcut>.
  CREATE TABLE config_aliases (
    guild_id           TEXT NOT NULL,
    shortcut           TEXT NOT NULL,
    command            TEXT NOT NULL,  -- "levels rank"
    discord_command_id TEXT,           -- the guild application command
    created_by         TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    PRIMARY KEY (guild_id, shortcut)
  );
  `
);

// ---------------------------------------------------------------- caches (listener hot paths)

/** guildId -> { welcome: Map(channelId -> row), goodbye: Map, boost: Map } */
const joinCache = guildCache((guildId) => {
  const out = { welcome: new Map(), goodbye: new Map(), boost: new Map() };
  for (const row of db.all("SELECT * FROM config_join_messages WHERE guild_id = ?", guildId)) out[row.kind].set(row.channel_id, row);
  return out;
});

/** guildId -> Map(channelId -> row). Rows are mutated in place for last_message_id. */
const stickyCache = guildCache((guildId) => {
  const rows = db.all("SELECT * FROM config_sticky_messages WHERE guild_id = ?", guildId);
  return new Map(rows.map((r) => [r.channel_id, r]));
});

/** guildId -> Map(channelId -> { thread }) */
const galleryCache = guildCache((guildId) => {
  const rows = db.all("SELECT * FROM config_gallery_channels WHERE guild_id = ?", guildId);
  return new Map(rows.map((r) => [r.channel_id, { thread: Boolean(r.thread) }]));
});

/** guildId -> Map(shortcut -> row) (read on every alias invocation) */
const aliasCache = guildCache((guildId) => {
  const rows = db.all("SELECT * FROM config_aliases WHERE guild_id = ?", guildId);
  return new Map(rows.map((r) => [r.shortcut, r]));
});

// ---------------------------------------------------------------- join messages

const joinMessages = {
  get: (guildId, kind, channelId) => joinCache.get(guildId)[kind].get(channelId) ?? null,
  list: (guildId, kind) => [...joinCache.get(guildId)[kind].values()],
  set(guildId, kind, channelId, { script, selfDestruct = null, pingable = false }) {
    db.run(
      `INSERT INTO config_join_messages (guild_id, channel_id, kind, script, self_destruct, pingable, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, kind, channel_id) DO UPDATE SET
         script = excluded.script, self_destruct = excluded.self_destruct, pingable = excluded.pingable`,
      guildId, channelId, kind, script, selfDestruct, pingable, Date.now()
    );
    joinCache.invalidate(guildId);
  },
  remove(guildId, kind, channelId) {
    const { changes } = db.run("DELETE FROM config_join_messages WHERE guild_id = ? AND kind = ? AND channel_id = ?", guildId, kind, channelId);
    joinCache.invalidate(guildId);
    return changes > 0;
  },
};

// ---------------------------------------------------------------- webhooks

const webhooks = {
  get: (guildId, identifier) => db.get("SELECT * FROM config_webhooks WHERE guild_id = ? AND identifier = ?", guildId, identifier) ?? null,
  byWebhookId: (guildId, webhookId) => db.get("SELECT * FROM config_webhooks WHERE guild_id = ? AND webhook_id = ?", guildId, webhookId) ?? null,
  list: (guildId) => db.all("SELECT * FROM config_webhooks WHERE guild_id = ? ORDER BY created_at", guildId),
  exists: (guildId, identifier) => Boolean(db.get("SELECT 1 FROM config_webhooks WHERE guild_id = ? AND identifier = ?", guildId, identifier)),
  add(row) {
    db.run(
      `INSERT INTO config_webhooks (guild_id, identifier, webhook_id, webhook_token_encrypted, channel_id, name, creator_id, locked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      row.guildId, row.identifier, row.webhookId, row.token, row.channelId, row.name, row.creatorId, Date.now()
    );
  },
  setLocked: (guildId, identifier, locked) =>
    db.run("UPDATE config_webhooks SET locked = ? WHERE guild_id = ? AND identifier = ?", locked, guildId, identifier).changes > 0,
  setToken: (guildId, identifier, token) =>
    db.run("UPDATE config_webhooks SET webhook_token_encrypted = ? WHERE guild_id = ? AND identifier = ?", token, guildId, identifier),
  remove: (guildId, identifier) => db.run("DELETE FROM config_webhooks WHERE guild_id = ? AND identifier = ?", guildId, identifier).changes > 0,
};

// ---------------------------------------------------------------- sticky messages

const sticky = {
  get: (guildId, channelId) => stickyCache.get(guildId).get(channelId) ?? null,
  list: (guildId) => [...stickyCache.get(guildId).values()],
  set(guildId, channelId, script) {
    db.run(
      `INSERT INTO config_sticky_messages (guild_id, channel_id, script, last_message_id, created_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET script = excluded.script`,
      guildId, channelId, script, Date.now()
    );
    stickyCache.invalidate(guildId);
  },
  /** Called after each repost: updates the row and the cached copy without reloading the guild. */
  setLastMessage(guildId, channelId, messageId) {
    db.run("UPDATE config_sticky_messages SET last_message_id = ? WHERE guild_id = ? AND channel_id = ?", messageId, guildId, channelId);
    const row = stickyCache.get(guildId).get(channelId);
    if (row) row.last_message_id = messageId;
  },
  remove(guildId, channelId) {
    const row = sticky.get(guildId, channelId);
    db.run("DELETE FROM config_sticky_messages WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    stickyCache.invalidate(guildId);
    return row;
  },
};

// ---------------------------------------------------------------- gallery channels

const gallery = {
  get: (guildId, channelId) => galleryCache.get(guildId).get(channelId) ?? null,
  list: (guildId) => [...galleryCache.get(guildId).entries()].map(([channelId, v]) => ({ channel_id: channelId, ...v })),
  set(guildId, channelId, thread) {
    db.run(
      `INSERT INTO config_gallery_channels (guild_id, channel_id, thread) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET thread = excluded.thread`,
      guildId, channelId, thread
    );
    galleryCache.invalidate(guildId);
  },
  remove(guildId, channelId) {
    const { changes } = db.run("DELETE FROM config_gallery_channels WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    galleryCache.invalidate(guildId);
    return changes > 0;
  },
};

// ---------------------------------------------------------------- aliases

const aliases = {
  get: (guildId, shortcut) => aliasCache.get(guildId).get(shortcut) ?? null,
  list: (guildId) => [...aliasCache.get(guildId).values()].sort((a, b) => a.shortcut.localeCompare(b.shortcut)),
  /** Every distinct shortcut name across guilds (to route interactions). */
  allShortcuts: () => db.all("SELECT DISTINCT shortcut FROM config_aliases").map((r) => r.shortcut),
  /** Guild ids that have at least one alias (boot-time resync). */
  guilds: () => db.all("SELECT DISTINCT guild_id FROM config_aliases").map((r) => r.guild_id),
  add(guildId, shortcut, command, discordCommandId, createdBy) {
    db.run(
      "INSERT INTO config_aliases (guild_id, shortcut, command, discord_command_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      guildId, shortcut, command, discordCommandId, createdBy, Date.now()
    );
    aliasCache.invalidate(guildId);
  },
  setDiscordId(guildId, shortcut, discordCommandId) {
    db.run("UPDATE config_aliases SET discord_command_id = ? WHERE guild_id = ? AND shortcut = ?", discordCommandId, guildId, shortcut);
    aliasCache.invalidate(guildId);
  },
  remove(guildId, shortcut) {
    const { changes } = db.run("DELETE FROM config_aliases WHERE guild_id = ? AND shortcut = ?", guildId, shortcut);
    aliasCache.invalidate(guildId);
    return changes > 0;
  },
};

/** A channel was deleted: drop everything configured for it. */
function forgetChannel(guildId, channelId) {
  db.transaction(() => {
    db.run("DELETE FROM config_join_messages WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    db.run("DELETE FROM config_sticky_messages WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    db.run("DELETE FROM config_gallery_channels WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
    db.run("DELETE FROM config_webhooks WHERE guild_id = ? AND channel_id = ?", guildId, channelId);
  });
  joinCache.invalidate(guildId);
  stickyCache.invalidate(guildId);
  galleryCache.invalidate(guildId);
}

module.exports = { joinMessages, webhooks, sticky, gallery, aliases, forgetChannel };
