/**
 * WP3: /config (welcome/goodbye/boost messages, server images, the bot's
 * per-server profile, webhooks, sticky messages, gallery channels, aliases).
 */
require("./db"); // runs migrations

module.exports = {
  name: "config",
  commands: [require("./commands/config")],
  setup(client) {
    require("./aliases").install(client);
    require("./listeners")();
  },
};
