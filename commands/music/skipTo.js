const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Skips to a certain song in the queue.
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('skipto')
		.setDescription('Skips to a certain song in the queue.')
		.addIntegerOption((option) =>
			option
				.setName('position')
				.setDescription('The position of the song in the queue.')
				.setRequired(true)
		),
	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

		const args = interaction.options.getInteger('position');

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

		if (args > queue.songs.length || (args && !queue.songs[args]))
			return interaction.editReply('Song not found.');

		await client.distube.jump(interaction, args);

		const embed = new EmbedBuilder()
			.setColor(client.color)
			.setDescription(`⏭ | **Skip to:** ${args}`);

		interaction.editReply({ embeds: [embed] });
	},
};
