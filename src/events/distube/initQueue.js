const { EmbedBuilder } = require('discord.js');
require('dotenv').config();

/**
 * Emited when the queue is empty.
 * @param {BotClient} client
 * @param {Queue} client
 */
module.exports = async (client, queue) => {
	queue.autoplay = true;
	queue.volume = 100;
};
