const player = require("../../utils/player");

/**
 * Emitted when a queue is removed: it finished, was stopped, or the bot was
 * disconnected. Turns the player panel into its "ended" state.
 * @param {BotClient} client
 * @param {Queue} queue
 */
module.exports = async (client, queue) => {
  await player.end(client, queue);
};
