/**
 * WP1 server admin: /settings /ignore /access /invoke /channel
 * /antiraid honeypot /emoji /sticker. (/prefix is skipped: this bot has no
 * text commands.)
 */
require("./db"); // migrations

module.exports = {
  name: "server-admin",
  commands: [
    require("./commands/settings"),
    require("./commands/ignore"),
    require("./commands/access"),
    require("./commands/invoke"),
    require("./commands/channel"),
    require("./commands/antiraid"),
    require("./commands/emoji"),
    require("./commands/sticker"),
  ],
  setup(client) {
    require("./listeners")(client);
  },
  api: {
    /** Map(channelId -> punishment) of honeypot channels, cached. */
    honeypots: (guildId) => require("./db").honeypots.get(guildId),
  },
};
