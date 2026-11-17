/**
 * WP8 /autorole: join roles, reaction roles, button roles, dropdown roles.
 * See docs/bleed-server-mgmt-guide/packages/WP08-autorole.md.
 */
const store = require("./db"); // runs migrations

module.exports = {
  name: "autorole",
  commands: [require("./commands/autorole")],
  setup(client) {
    require("./listeners")(client);
  },
  api: {
    /** Join roles of a guild (role IDs). */
    joinRoles: (guildId) => [...store.join.list(guildId)],
    /**
     * Hands a set of reaction-role menus to this engine (the web panel's menu
     * builder uses it). Replaces everything previously synced by `managedBy`.
     * See db.js groups.syncManaged for the shape.
     */
    syncManagedMenus: (guildId, managedBy, menus) => store.groups.syncManaged(guildId, managedBy, menus),
    /** Recent reaction-role events, newest first. */
    activity: () => require("./listeners").activity,
  },
};
