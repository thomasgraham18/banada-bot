/**
 * WP11: /giveaways. Giveaways with an Enter button, entry requirements
 * (roles, levels, account age, server stay), award roles and rerolls.
 *
 * Requiring ./service runs the migrations (./db) and defines the
 * "giveaways:end" scheduler job, so ends survive restarts.
 */
const service = require("./service");

module.exports = {
  name: "giveaways",
  commands: [require("./commands/giveaways")],
  setup() {
    service.registerComponents();
  },
};
