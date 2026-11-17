/**
 * /automation package (guide WP7): pagination embeds, pin archive, social
 * reposter settings, publisher, channel counters, timers and leaderboards.
 *
 * Scheduler kinds (defined when their modules load):
 *   automation:counter      rename a counter channel (every 10 min)
 *   automation:timer        post a repeating message
 *   automation:leaderboard  redraw a leaderboard (every 10 min)
 *   automation:prune-stats  drop old daily activity buckets (daily)
 */
require("./db"); // migrations
require("./counters");
require("./timers");
require("./leaderboards");

module.exports = {
  name: "automation",
  commands: [require("./commands/automation")],
  setup(client) {
    require("./listeners")(client);
  },
};
