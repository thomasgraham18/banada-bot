/**
 * WP2: /filter (chat filters, Discord AutoMod mirroring, points escalation).
 *
 * api (for other packages):
 *   copyChannel(guildId, fromChannelId, toChannelId)  used by /access copy
 *   getPoints(guildId, userId)                        current filter points (after decay)
 *   hiddenFromSnipe(message)                          true when /filter snipe hides it
 */
const store = require("./db"); // runs migrations
const automod = require("./automod");
const service = require("./service");

let clientRef = null;

/** /access copy: duplicates the per-channel filter settings onto another channel. */
function copyChannel(guildId, fromChannelId, toChannelId) {
  const { changes } = store.copyChannelSettings(guildId, fromChannelId, toChannelId);
  // The new channel override changes the AutoMod exempt-channel lists.
  const guild = clientRef?.guilds.cache.get(guildId);
  if (changes && guild) automod.syncAll(guild).catch(() => {});
  return changes;
}

module.exports = {
  name: "filter",
  commands: [require("./commands/filter")],
  setup(client) {
    clientRef = client;
    require("./listeners")(client);
  },
  api: {
    copyChannel,
    getPoints: service.getPoints,
    hiddenFromSnipe: service.hiddenFromSnipe,
  },
};
