/**
 * WP5: /suggest, the suggestion system.
 * Votes and review decisions use persistent buttons (prefix "sugg"), stored
 * in the database, so they keep working after a restart.
 */
const store = require("./db"); // requiring it runs the migrations

module.exports = {
  name: "suggest",
  commands: [require("./commands/suggest")],
  setup() {
    require("./components").register();
  },
  api: {
    /** Read-only access for other packages (e.g. a dashboard). */
    getSuggestion: store.getSuggestion,
    getSettings: store.getSettings,
  },
};
