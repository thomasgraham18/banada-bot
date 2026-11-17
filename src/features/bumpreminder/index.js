/**
 * WP13: /bumpreminder (DISBOARD bump reminders).
 *
 * Requiring db.js runs the migration; requiring service.js defines the
 * "bumpreminder:remind" scheduler kind.
 */
require("./db");
const service = require("./service");
const logic = require("./logic");

module.exports = {
  name: "bumpreminder",
  commands: [require("./commands/bumpreminder")],
  setup(client) {
    require("./listeners")(client);
  },
  api: {
    /** Settings row for a guild (cached). */
    settings: (guildId) => require("./db").get(guildId),
    detectBump: logic.detectBump,
    cancel: service.cancel,
  },
};
