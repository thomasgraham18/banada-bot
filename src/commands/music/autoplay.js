const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Enables autoplay
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('autoplay')
		.setDescription('Enable autoplay'),

	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

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

		// This is a switch for autoplay
		if (!queue.autoplay) {
			await client.distube.toggleAutoplay(interaction);

			const embed = new EmbedBuilder()
				.setColor(client.colour)
				.setDescription(`📻 | **Autoplay has been:** \`Activated\``);

			interaction.editReply({ embeds: [embed] });
		} else {
			await client.distube.toggleAutoplay(interaction);

			const embed = new EmbedBuilder()
				.setColor(client.colour)
				.setDescription(`📻 | **Autoplay has been:** \`Deactivated\``);

			interaction.editReply({ embeds: [embed] });
		}
	},
};
