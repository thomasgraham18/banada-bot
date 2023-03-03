const { EmbedBuilder } = require('discord.js');
require('dotenv').config();

/**
 * Emited when the queue is empty.
 * @param {BotClient} client
 * @param {Queue} client
 */
module.exports = async (client, queue) => {
	if (process.env.LEAVE_FINISH == 'false') {
		const embed = new EmbedBuilder()
			.setDescription(`\`🍁\` |  **Song:**  \`Ended\``)
			.setColor('#000001');

		queue.textChannel.send({ embeds: [embed] });
	} else if (process.env.LEAVE_FINISH == 'true') {
		await client.distube.voices.leave(queue.textChannel.guild);

		const embed = new EmbedBuilder()
			.setDescription(`\`🍁\` |  **Song:**  \`Ended\``)
			.setColor('#000001');

		queue.textChannel.send({ embeds: [embed] });
	}
};
