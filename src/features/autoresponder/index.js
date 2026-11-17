/**
 * WP6: /autoresponder and /reaction (trigger-based replies and reactions,
 * channel auto reactions, no-self-react).
 *
 *   matcher.js    trigger matching rules + per-guild compiled matcher (pure)
 *   cooldown.js   in-memory cooldowns (pure)
 *   db.js         tables, queries and the listener caches
 *   listeners.js  messageCreate / messageReactionAdd listeners
 *   commands/     the two top-level commands
 */
require("./db"); // runs migrations

const matcher = require("./matcher");

module.exports = {
  name: "autoresponder",
  commands: [require("./commands/autoresponder"), require("./commands/reaction")],
  setup() {
    require("./listeners")();
  },
  api: {
    /** Does `text` match `trigger` under this package's rules? */
    matches: matcher.matches,
  },
};
