const {
	InteractionType,
	PermissionsBitField,
	CommandInteraction,
} = require('discord.js');
const ytsr = require('@distube/ytsr');
const SEARCH_DEFAULT = ['lo fi', '83hades', 'xxxtentacion', 'lil uzi vert'];

/**
 * Emited when a slash command is used.
 * @param {BotClient} client
 * @param {*} interaction
 * @returns
 */
module.exports = async (client, interaction) => {
	// Check for guild and user
	if (!interaction.guild || interaction.user.bot) return;

	// Check for slash command
	if (!interaction.isChatInputCommand()) return;

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(
			`No command matching ${interaction.commandName} was found.`
		);
		return;
	}

	if (interaction.type == InteractionType.ApplicationCommandAutocomplete) {
		const Random =
			SEARCH_DEFAULT[Math.floor(Math.random() * SEARCH_DEFAULT.length)];

		if (interaction.commandName == 'play') {
			let choice = [];
			await ytsr(interaction.options.getString('search') || Random, {
				safeSearch: true,
				limit: 10,
			}).then((result) => {
				result.items.forEach((x) => {
					choice.push({ name: x.name, value: x.url });
				});
			});
			return await interaction.respond(choice).catch(() => {});
		} else if (interaction.options.getSubcommand() == 'playskip') {
			let choice = [];
			await ytsr(interaction.options.getString('search') || Random, {
				safeSearch: true,
				limit: 10,
			}).then((result) => {
				result.items.forEach((x) => {
					choice.push({ name: x.name, value: x.url });
				});
			});
			return await interaction.respond(choice).catch(() => {});
		} else if (interaction.options.getSubcommand() == 'playtop') {
			let choice = [];
			await ytsr(interaction.options.getString('search') || Random, {
				safeSearch: true,
				limit: 10,
			}).then((result) => {
				result.items.forEach((x) => {
					choice.push({ name: x.name, value: x.url });
				});
			});
			return await interaction.respond(choice).catch(() => {});
		}
	}

	try {
		command.execute(interaction, client);
	} catch (error) {
		console.error(error);
		await interaction.reply({
			content: 'There was an error while executing this command!',
			ephemeral: true,
		});
	}
};
