const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Shows the current playing song.
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('nowplaying')
		.setDescription('Shows the current playing song.'),

	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

		const queue = client.distube.getQueue(interaction);

		// Check if queue is empty
		if (!queue) {
			return interaction.editReply(`There is nothing playing.`);
		}

		const { channel } = interaction.member.voice;

		// Check if user is in a voice channel
		if (!channel)
			return interaction.editReply('You are not in a voice channel!');

		// Make sure the bot is in the same channel as the user
		if (
			interaction.member.voice.channel !==
			interaction.guild.members.me.voice.channel
		)
			return interaction.editReply(
				'You are not in the same voice channel as me!'
			);

		const emojie = `${queue.songs[0].playing ? '⏸️ |' : '🔴 |'}`;

		const part = Math.floor(
			(queue.currentTime / queue.songs[0].duration) * 30
		);

		const embed = new EmbedBuilder()
			.setAuthor({
				name: queue.songs[0].playing
					? 'Song Pause...'
					: 'Now Playing...',
				iconURL:
					'https://cdn.discordapp.com/emojis/741605543046807626.gif',
			})
			.setColor(client.colour)
			.setDescription(
				`**[${queue.songs[0].name}](${queue.songs[0].url})**`
			)
			.setThumbnail(`${queue.songs[0].thumbnail}`)
			.addFields({
				name: 'Uploader:',
				value: `[${queue.songs[0].uploader.name}](${queue.songs[0].uploader.url})`,
				inline: true,
			})
			.addFields({
				name: 'Requester:',
				value: `${queue.songs[0].user}`,
				inline: true,
			})
			.addFields({
				name: 'Volume:',
				value: `${queue.volume}%`,
				inline: true,
			})
			.addFields({
				name: 'Views',
				value: `${queue.songs[0].views}`,
				inline: true,
			})
			.addFields({
				name: 'Likes:',
				value: `${queue.songs[0].likes}`,
				inline: true,
			})
			.addFields({
				name: `Current Duration: \`[${queue.formattedCurrentTime} / ${queue.songs[0].formattedDuration}]\``,
				value: `\`\`\`${emojie} ${
					'─'.repeat(part) + '🎶' + '─'.repeat(30 - part)
				}\`\`\``,
				inline: false,
			})
			.setTimestamp();

		interaction.editReply({ embeds: [embed] });
	},
};
