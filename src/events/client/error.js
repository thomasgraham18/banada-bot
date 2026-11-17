const { red } = require("chalk");

/**
 * Emitted when discord.js hits an error. Without a listener Node would crash.
 * @param {BotClient} client
 * @param {Error} error
 */
module.exports = async (client, error) => {
  console.error(red("[ERROR]"), "An error event was sent by Discord.js:", error);
};
