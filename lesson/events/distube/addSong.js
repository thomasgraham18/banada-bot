const { EmbedBuilder } = require('discord.js');

/**
 * Emited when a song is added to the queue.
 * @param {BotClient} client
 * @param {Queue} client
 * @param {Song} song
 */
module.exports = async (client, queue, song) => {
	const embed = new EmbedBuilder()
		.setColor('#000001')
		.setDescription(
			`**Queued • [${song.name}](${song.url})** \`${song.formattedDuration}\` • ${song.user}`
		);

	queue.textChannel.send({ embeds: [embed] });
};
