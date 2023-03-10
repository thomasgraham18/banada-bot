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
		console.log('play command');
		try {
			if (interaction.options.get('search')) {
				await interaction.reply(
					`🔍 **Searching...** \`${interaction.options.getString(
						'search'
					)}\``
				);

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
						`I don't have perm \`CONNECT\` in ${channel.name} to join voice!`
					);
				if (
					!channel
						.permissionsFor(interaction.guild.members.me)
						.has(PermissionsBitField.Flags.Speak)
				)
					return interaction.editReply(
						`I don't have perm \`SPEAK\` in ${channel.name} to join voice!`
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
