/**
 * VoiceMaster storage.
 *
 *   voicemaster_config    one row per guild: hub, interface channel, categories, defaults
 *   voicemaster_channels  one row per live temporary voice channel (its owner and state)
 *
 * Both are read on every voice state change, so reads go through guildCache
 * and every write invalidates the guild.
 */
const { db, guildCache } = require("../../core");

db.migrate(
  "voicemaster_001_init",
  `
  CREATE TABLE voicemaster_config (
    guild_id             TEXT PRIMARY KEY,
    hub_channel_id       TEXT,              -- the "Join to Create" voice channel
    interface_channel_id TEXT,              -- text channel holding the panel
    public_category_id   TEXT,              -- where new channels go
    private_category_id  TEXT,              -- where ghosted channels go
    created_category_id  TEXT,              -- category made by /voicemaster setup (deleted by reset)
    default_name         TEXT,              -- template, e.g. "{user.display_name}'s channel"
    default_region       TEXT,              -- RTC region id, NULL = automatic
    default_bitrate      INTEGER,           -- kbps, NULL = Discord's default (64)
    default_interface    INTEGER NOT NULL DEFAULT 0,
    join_role_id         TEXT,              -- held by anyone in a VoiceMaster channel
    default_role_id      TEXT               -- role lock/ghost/music act on, NULL = @everyone
  );

  CREATE TABLE voicemaster_channels (
    guild_id   TEXT NOT NULL,
    channel_id TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL,
    locked     INTEGER NOT NULL DEFAULT 0,
    ghosted    INTEGER NOT NULL DEFAULT 0,
    music      INTEGER NOT NULL DEFAULT 0,
    role_id    TEXT,                        -- /voicemaster role: given to everyone inside
    created_at INTEGER NOT NULL
  );
  CREATE INDEX voicemaster_channels_guild ON voicemaster_channels (guild_id);
`
);

// Columns that may be written through setConfig / updateChannel. Whitelisting
// them keeps the dynamic "SET col = ?" SQL below safe from injection.
const CONFIG_COLUMNS = new Set([
  "hub_channel_id", "interface_channel_id", "public_category_id", "private_category_id",
  "created_category_id", "default_name", "default_region", "default_bitrate",
  "default_interface", "join_role_id", "default_role_id",
]);
const CHANNEL_COLUMNS = new Set(["owner_id", "locked", "ghosted", "music", "role_id"]);

// guildId -> config row or null
const configCache = guildCache((guildId) => db.get("SELECT * FROM voicemaster_config WHERE guild_id = ?", guildId) ?? null);
// guildId -> Map(channelId -> row)
const channelCache = guildCache(
  (guildId) => new Map(db.all("SELECT * FROM voicemaster_channels WHERE guild_id = ?", guildId).map((r) => [r.channel_id, r]))
);

const assertColumns = (fields, allowed) => {
  for (const key of Object.keys(fields)) if (!allowed.has(key)) throw new Error(`voicemaster: unknown column "${key}"`);
};

/** The guild's config row, or null when VoiceMaster was never configured. */
const getConfig = (guildId) => configCache.get(guildId);

/** Upserts some config columns (null clears one). */
function setConfig(guildId, fields) {
  assertColumns(fields, CONFIG_COLUMNS);
  db.run("INSERT OR IGNORE INTO voicemaster_config (guild_id) VALUES (?)", guildId);
  const keys = Object.keys(fields);
  if (keys.length)
    db.run(`UPDATE voicemaster_config SET ${keys.map((k) => `${k} = :${k}`).join(", ")} WHERE guild_id = :guild_id`, {
      ...fields,
      guild_id: guildId,
    });
  configCache.invalidate(guildId);
  return getConfig(guildId);
}

function deleteConfig(guildId) {
  db.run("DELETE FROM voicemaster_config WHERE guild_id = ?", guildId);
  configCache.invalidate(guildId);
}

/** Every configured guild (for the startup sweep). */
const allConfigs = () => db.all("SELECT * FROM voicemaster_config");

/** Temp channel row by id (null if it isn't a VoiceMaster channel). */
const getChannel = (guildId, channelId) => channelCache.get(guildId).get(channelId) ?? null;
const listChannels = (guildId) => [...channelCache.get(guildId).values()];
/** Every stored temp channel, across guilds (for the startup sweep). */
const allChannels = () => db.all("SELECT * FROM voicemaster_channels");
const ownedBy = (guildId, userId) => listChannels(guildId).find((r) => r.owner_id === userId) ?? null;

function addChannel(guildId, channelId, ownerId) {
  db.run(
    "INSERT OR REPLACE INTO voicemaster_channels (guild_id, channel_id, owner_id, created_at) VALUES (?, ?, ?, ?)",
    guildId, channelId, ownerId, Date.now()
  );
  channelCache.invalidate(guildId);
}

function updateChannel(guildId, channelId, fields) {
  assertColumns(fields, CHANNEL_COLUMNS);
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.run(`UPDATE voicemaster_channels SET ${keys.map((k) => `${k} = :${k}`).join(", ")} WHERE channel_id = :channel_id`, {
    ...fields,
    channel_id: channelId,
  });
  channelCache.invalidate(guildId);
}

function removeChannel(guildId, channelId) {
  db.run("DELETE FROM voicemaster_channels WHERE channel_id = ?", channelId);
  channelCache.invalidate(guildId);
}

function removeGuildChannels(guildId) {
  db.run("DELETE FROM voicemaster_channels WHERE guild_id = ?", guildId);
  channelCache.invalidate(guildId);
}

module.exports = {
  getConfig,
  setConfig,
  deleteConfig,
  allConfigs,
  getChannel,
  listChannels,
  allChannels,
  ownedBy,
  addChannel,
  updateChannel,
  removeChannel,
  removeGuildChannels,
  CONFIG_COLUMNS,
};
