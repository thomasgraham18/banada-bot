const { EmbedBuilder } = require('discord.js');

/**
 * Emited when a song is playing.
 * @param {BotClient} client
 * @param {Queue} client
 * @param {Song} track
 */
module.exports = async (client, queue, track) => {
	var newQueue = client.distube.getQueue(queue.id);
	var data = wmadplayer(newQueue, track);

	await queue.textChannel.send(data);
};

function wmadplayer(nowQueue, nowTrack) {
	const embed = new EmbedBuilder()
		.setAuthor({
			name: `Starting Playing...`,
			iconURL: 'https://cdn.discordapp.com/emojis/741605543046807626.gif',
		})
		.setThumbnail(nowTrack.thumbnail)
		.setColor('#000001')
		.setDescription(`**[${nowTrack.name}](${nowTrack.url})**`)
		.addFields({
			name: `Uploader:`,
			value: `**[${nowTrack.uploader.name}](${nowTrack.uploader.url})**`,
			inline: true,
		})
		.addFields({
			name: `Total Duration:`,
			value: `${nowQueue.formattedDuration}`,
			inline: true,
		})
		.setTimestamp();

	return {
		embeds: [embed],
	};
}
