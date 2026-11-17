const player = require("../../utils/player");

/**
 * Emitted when a song starts playing. Updates the player panel
 * (see utils/player.js for the panel and its buttons).
 * @param {BotClient} client
 * @param {Queue} queue
 */
module.exports = async (client, queue) => {
  await player.show(client, queue);
};
