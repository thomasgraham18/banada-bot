/**
 * WP12: /starboard and /clownboard. One engine (engine.js) parameterised by
 * kind; both command trees come from commands/factory.js.
 */
const store = require("./db"); // runs migrations

module.exports = {
  name: "boards",
  commands: [require("./commands/starboard"), require("./commands/clownboard")],
  setup(client) {
    require("./listeners")(client);
  },
  api: {
    /** Resolved settings for a board: getSettings(guildId, "starboard" | "clownboard"). */
    getSettings: (guildId, kind) => store.settings.get(guildId)[kind] ?? null,
  },
};
