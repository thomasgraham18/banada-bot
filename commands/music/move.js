const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Move a song in the queue
 */
module.exports = {
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('move')
		.setDescription('Move a song in queue')
		.addIntegerOption((option) =>
			option
				.setName('queue')
				.setDescription('The queue of the song')
				.setRequired(true)
		)
		.addIntegerOption((option) =>
			option
				.setName('position')
				.setDescription('The position in queue want to move too.')
				.setRequired(true)
		),
	// Command execution
	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

		const tracks = interaction.options.getInteger('queue');
		const position = interaction.options.getInteger('position');

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
				`Cannot move song, it's already playing.`
			);
		if (position == 0)
			return interaction.editReply(
				`Cannot move to this position, song already playing.`
			);
		if (tracks > queue.songs.length)
			return interaction.editReply(`Queue | Song not found.`);
		if (position > queue.songs.length)
			return interaction.editReply(`Position | Song not found.`);

		const song = queue.songs[tracks];

		await queue.songs.splice(tracks);
		await queue.addToQueue(song, position);

		const embed = new EmbedBuilder()
			.setDescription(
				`**Moved • [${song.name}](${song.url})** to ${position}`
			)
			.setColor(client.color);

		interaction.editReply({ embeds: [embed] });
	},
};
