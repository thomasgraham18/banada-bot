/**
 * Moderation commands: /kick, /restart.
 * Classic command modules ({ data, execute }), deferred by interactionCreate.js.
 */
const { loadCommandFiles } = require("../../handlers/features");

module.exports = {
  name: "moderation",
  commands: loadCommandFiles(__dirname),
};
