/**
 * Music player (DisTube): /play, /queue, /skip, /volume ...
 *
 * These are "classic" command modules ({ data, execute }) rather than
 * core/router defineCommand trees: events/guild/interactionCreate.js defers
 * them before execute() runs, so they reply with interaction.editReply().
 * The player itself lives in utils/player.js and events/distube/.
 */
const { loadCommandFiles } = require("../../handlers/features");

module.exports = {
  name: "music",
  commands: loadCommandFiles(__dirname),
};
