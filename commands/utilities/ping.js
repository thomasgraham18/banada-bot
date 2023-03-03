const { SlashCommandBuilder } = require('discord.js');

module.exports = {
	// The data property provides the command definition for registering to Discord.
	// Slash command properties
	data: new SlashCommandBuilder()
		.setName('ping')
		.setDescription('Replies with Pong!'),
	// The execute method, which will contain the functionality to run from our event handler when the command is used.
	async execute(interaction) {
		await interaction.reply('Pong!');
	},
};
