const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Remove a song from the queue
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('remove')
		.setDescription('Remove a song from the queue')
		.addIntegerOption((option) =>
			option
				.setName('position')
				.setDescription('The position in queue want to remove.')
				.setRequired(true)
		),
	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

		const tracks = interaction.options.getInteger('position');

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

		if (tracks == 0)
			return interaction.editReply(
				`Cannot remove a song already playing.`
			);
		if (tracks > queue.songs.length)
			return interaction.editReply(`Song not found.`);

		const song = queue.songs[tracks];

		await queue.songs.splice(tracks, 1);

		const embed = new EmbedBuilder()
			.setColor(client.colour)
			.setDescription(
				`**Removed • [${song.name}](${song.url})** \`${song.formattedDuration}\` • ${song.user}`
			);

		interaction.editReply({ content: ' ', embeds: [embed] });
	},
};
