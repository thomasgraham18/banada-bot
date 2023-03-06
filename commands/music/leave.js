const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Leave the voice channel
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('leave')
		.setDescription('Leave the voice channel'),

	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

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

		await client.distube.voices.leave(interaction.guild);

		const embed = new EmbedBuilder()
			.setDescription(`💨 | **Left:** \`${channel.name}\``)
			.setColor(client.color);

		interaction.editReply({ embeds: [embed] });
	},
};
