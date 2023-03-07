const { Client, Events, GatewayIntentBits, Collection } = require('discord.js');
const { DisTube } = require('distube');

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.MessageContent,
	],
});

// Bot config settings
token = 'token here';

// Distube setup
client.distube = new DisTube(client, {
	leaveOnEmpty: false,
	emptyCooldown: 60,
	leaveOnFinish: false,
	leaveOnStop: false,
});

client.commands = new Collection();

// Load handlers
//? client is just an easy way of loading all the handlers in the handlers folder while passing the client.
['commands', 'events'].forEach((x) => require(`./handlers/${x}`)(client));

client.once(Events.ClientReady, (c) => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.login(token);

client.on(Events.InteractionCreate, async (interaction) => {
	// Not every interaction is a slash command (e.g. MessageComponent interactions). Make sure to only handle slash commands in this function by making use of the BaseInteraction#isChatInputCommand method to exit the handler if another type is encountered.
	if (!interaction.isChatInputCommand()) return;

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(
			`No command matching ${interaction.commandName} was found.`
		);
		return;
	}
	try {
		await command.execute(interaction, client);
	} catch (error) {
		console.error(error);
		await interaction.reply({
			content: 'There was an error while executing this command!',
			ephemeral: true,
		});
	}
});
