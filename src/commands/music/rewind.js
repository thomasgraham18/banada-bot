const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Rewind the current song
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('rewind')
		.setDescription('Rewind the current song')
		.addIntegerOption((option) =>
			option
				.setName('seconds')
				.setDescription('The amount of seconds to rewind the song by')
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

		if (!value) {
			if (queue.currentTime - 10 > 0) {
				await queue.seek(queue.currentTime - 10);

				const embed = new EmbedBuilder()
					.setDescription(
						`⏮ *Rewind to:* \`${queue.formattedCurrentTime}\``
					)
					.setColor(client.colour);

				interaction.editReply({ embeds: [embed] });
			} else {
				interaction.editReply(
					`Cannot rewind beyond the song's duration.`
				);
			}
		} else if (queue.currentTime - value > 0) {
			await queue.seek(queue.currentTime - value);

			const embed = new EmbedBuilder()
				.setDescription(
					`⏮ | **Rewinded to:** \`${queue.formattedCurrentTime}\``
				)
				.setColor(client.colour);

			interaction.editReply({ embeds: [embed] });
		} else {
			interaction.editReply(`Cannot rewind beyond the song's duration.`);
		}
	},
};
