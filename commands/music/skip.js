const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Skip the current song
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Skip the current song'),

	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: true });

		const queue = client.distube.getQueue(interaction);

		// Check if queue is empty
		if (!queue)
			return interaction.editReply('There is nothing in the queue!');

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

		if (queue.songs.length === 1 && queue.autoplay === false) {
			const embed = new EmbedBuilder()
				.setColor(client.color)
				.setDescription('🚨 | **There are no** `Songs` **in queue**');

			interaction.editReply({ embeds: [embed] });
		} else {
			await client.distube.skip(interaction);

			const embed = new EmbedBuilder()
				.setColor(client.color)
				.setDescription('⏭ | **Song:**  `Skipped`');

			interaction.editReply({ embeds: [embed] });
		}
	},
};
