const {
	SlashCommandBuilder,
	EmbedBuilder,
	PermissionFlagBits,
	Embed,
} = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('restart')
		.setDescription('Restart the bot if it becomes unresponsive'),

	async execute(interaction, client) {
		await interaction.deferReply({ ephemeral: false });

		await client.distube.voices.leave(interaction.guild);

		await client.distube.stop(interaction.guild);

		const embed = new EmbedBuilder()
			.setDescription(`🔁 | **Restarted, should be good to go**`)
			.setColor(client.colour);

		interaction.editReply({ embeds: [embed] });
	},
};
