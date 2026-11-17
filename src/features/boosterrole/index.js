/**
 * WP4: /boosterrole (custom booster roles) and /badge (guild tag rewards).
 * See docs/bleed-server-mgmt-guide/packages/WP04-boosterrole-badge.md.
 */
const store = require("./db"); // runs migrations
require("./roles"); // scheduler kind boosterrole:expire
require("./badge"); // scheduler kind boosterrole:badge-sweep

module.exports = {
  name: "boosterrole",
  commands: [require("./commands/boosterrole"), require("./commands/badge")],
  setup() {
    require("./listeners")();
  },
  api: {
    /** The booster role id a member owns in a guild, or null. */
    boosterRoleOf: (guildId, userId) => store.roles.byOwner(guildId, userId),
    /** True if we have recorded the member as wearing the guild's tag. */
    wearsGuildTag: (guildId, userId) => store.badge.get(guildId).members.has(userId),
  },
};
