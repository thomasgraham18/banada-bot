const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Foward time in the current song
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()

		.setName('foward')
		.setDescription('Foward the current song')
		.addIntegerOption((option) =>
			option
				.setName('seconds')
				.setDescription('The amount of seconds to foward the song by')
		),

	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

		const value = interaction.options.getInteger('seconds');

		const queue = client.distube.getQueue(interaction);
		// Check if queue is empty
		if (!queue)
			return interaction.editReply(
				`There is nothing in the queue right now!`
			);

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

		const song = queue.songs[0];

		if (!value) {
			if (queue.currentTime + 10 < song.duration) {
				await queue.seek(queue.currentTime + 10);

				const embed = new EmbedBuilder()
					.setDescription(
						`\`⏭\` | *Forward to:* \`${queue.formattedCurrentTime}\``
					)
					.setColor(client.color);

				interaction.editReply({ embeds: [embed] });
			} else {
				interaction.editReply(
					`Cannot forward beyond the song's duration.`
				);
			}
		} else if (queue.currentTime + value < song.duration) {
			await queue.seek(queue.currentTime + value);

			const embed = new EmbedBuilder()
				.setDescription(
					`\`⏭\` | *Forward to:* \`${queue.formattedCurrentTime}\``
				)
				.setColor(client.color);

			interaction.editReply({ embeds: [embed] });
		} else {
			interaction.editReply(`Cannot forward beyond the song's duration.`);
		}
	},
};
