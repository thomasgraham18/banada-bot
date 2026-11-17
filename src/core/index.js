/**
 * The core framework (guide WP0). Feature packages import from here:
 *
 *   const { defineCommand, db, config, guard, ui, parse, script, punish } = require("../../core");
 *
 * See docs/bleed-server-mgmt-guide/CORE.md for the full API.
 */
module.exports = {
  db: require("./db"),
  config: require("./config"),
  ...require("./cache"), // guildCache
  ...require("./errors"), // UserError, ensure
  embeds: require("./embeds"),
  parse: require("./parse"),
  guard: require("./guard"),
  access: require("./access"),
  script: require("./script"),
  ui: require("./ui"),
  scheduler: require("./scheduler"),
  ...require("./punish"), // punish, KINDS, invokeScript
  ...require("./log"), // logAction
  listeners: require("./listeners"),
  components: require("./components"),
  ...require("./router"), // defineCommand
};
