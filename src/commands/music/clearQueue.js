const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Clears the queue
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('clearqueue')
		.setDescription('Clear the queue'),

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

		// Clear the queue and update it
		await queue.songs.splice(1, queue.songs.length);

		// Embed
		const embed = new EmbedBuilder()
			.setDescription(`🍁 | *Queue has been:* \`Cleared\``)
			.setColor(client.colour);

		interaction.editReply({ embeds: [embed] });
	},
};
