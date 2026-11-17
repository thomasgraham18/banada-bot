/**
 * General commands: /help, /embedjson, /embedcustom.
 * Classic command modules ({ data, execute }), deferred by interactionCreate.js.
 */
const { loadCommandFiles } = require("../../handlers/features");

module.exports = {
  name: "general",
  commands: loadCommandFiles(__dirname),
};
