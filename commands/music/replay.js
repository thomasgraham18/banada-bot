const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Replay the current song
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('replay')
		.setDescription('Replay the current song'),

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
		await queue.seek(0);

		const embed = new EmbedBuilder()
			.setColor(client.color)
			.setDescription('🔁 | **Song:**  `Replay`');

		interaction.editReply({ embeds: [embed] });
	},
};
