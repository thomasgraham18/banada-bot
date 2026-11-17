/**
 * Levels package (guide WP10): /levels, XP on messages, level roles.
 *
 * api (used by giveaways and automation; keep names and shapes stable):
 *   getLevel(guildId, userId)                      -> number (0 when unknown)
 *   getXp(guildId, userId)                         -> number (0 when unknown)
 *   getLeaderboard(guildId, { limit, offset })     -> [{ userId, xp, level }] sorted by XP desc
 * All synchronous and cheap (one indexed SQLite read).
 */
const store = require("./db"); // runs migrations

module.exports = {
  name: "levels",
  commands: [require("./commands/levels")],
  setup(client) {
    require("./listeners")(client);
  },
  api: {
    getLevel: store.getLevel,
    getXp: store.getXp,
    getLeaderboard: store.getLeaderboard,
  },
};
