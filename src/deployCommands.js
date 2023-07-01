const { REST, Routes } = require('discord.js');
const recursive = require('recursive-readdir');
const path = require('path');
require('dotenv').config();

const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
const token = process.env.DISCORD_TOKEN;

const commands = [];

// Recursively read all the command files from the commands directory and its subdirectories
recursive('./commands', (err, files) => {
	if (err) {
		console.error(err);
		return;
	}

	// Filter out non-JS files
	const commandFiles = files.filter((file) => file.endsWith('.js'));

	// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
	for (const file of commandFiles) {
		const command = require(path.resolve(file));
		commands.push(command.data.toJSON());
	}

	// Construct and prepare an instance of the REST module
	const rest = new REST({ version: '10' }).setToken(token);

	// and deploy your commands!
	(async () => {
		try {
			console.log(
				`Started refreshing ${commands.length} application (/) commands.`
			);

			// The put method is used to fully refresh all commands in the guild with the current set
			const data = await rest.put(
				Routes.applicationCommands(clientId),
				{
					body: commands,
				}
			);

			console.log(
				`Successfully reloaded ${data.length} application (/) commands.`
			);
		} catch (error) {
			console.error(error);
		}
	})();
});