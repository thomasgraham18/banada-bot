const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Seek time in the current song
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('seek')
		.setDescription('Seek time in the current song')
		.addIntegerOption((option) =>
			option
				.setName('seconds')
				.setDescription('The amount of seconds to seek the song by')
				.setRequired(true)
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

		if (value >= queue.songs[0].duration || value < 0)
			return interaction.editReply(`Cannot seek beyond length of song.`);

		await queue.seek(value);

		const embed = new EmbedBuilder()
			.setDescription(
				`⏭ | **Seeked to:** \`${value}\` seconds in the song.`
			)
			.setColor(client.color);

		interaction.editReply({ embeds: [embed] });
	},
};
