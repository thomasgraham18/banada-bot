const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

/**
 * @description Play a song from the source
 */
module.exports = {
	// The data property provides the command definition for registering to Discord.
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('play')
		.setDescription('Plays a song from the source')
		.addStringOption((option) =>
			option
				.setName('search')
				.setDescription('The song to play')
				.setRequired(true)
		),

	// The execute method, which will contain the functionality to run from our event handler when the command is used.
	// Command execution
	async execute(interaction, client) {
		try {
			if (interaction.options.get('search')) {
				await interaction.reply(
					`🔍 **Searching...** \`${interaction.options.getString(
						'search'
					)}\``
				);

				const message = await interaction.fetchReply();

				//? We do this so we can edit the message later
				await client.createPlay(interaction, message.id);

				const { channel } = interaction.member.voice;
				if (!channel)
					return interaction.editReply(
						'You need to be in voice channel.'
					);
				if (
					!channel
						.permissionsFor(interaction.guild.members.me)
						.has(PermissionsBitField.Flags.Connect)
				)
					return interaction.editReply(
						`I don't have permission to \`CONNECT\` to ${channel.name}!`
					);
				if (
					!channel
						.permissionsFor(interaction.guild.members.me)
						.has(PermissionsBitField.Flags.Speak)
				)
					return interaction.editReply(
						`I don't have permission to \`SPEAK\` in ${channel.name}!`
					);

				try {
					const string = interaction.options.getString('search');

					const options = {
						member: interaction.member,
						textChannel: interaction.channel,
						interaction,
					};

					await client.distube.play(
						interaction.member.voice.channel,
						string,
						options
					);
				} catch (e) {
					console.log(e);
				}
			}
		} catch (e) {
			console.log(e);
		}
	},
};
