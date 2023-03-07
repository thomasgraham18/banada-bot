const { Client, Events, GatewayIntentBits, Collection } = require('discord.js');
require('dotenv').config();
const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { SpotifyPlugin } = require('@distube/spotify');

class BotClient extends Client {
	constructor() {
		super({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.GuildVoiceStates,
				GatewayIntentBits.MessageContent,
			],
			allowedMentions: { parse: ['users', 'roles'], repliedUser: true },
		});

		// Error handling
		process.on('unhandledRejection', (error) => {
			console.error('Unhandled promise rejection:', error);
		});
		process.on('uncaughtException', (error) => {
			console.error('Uncaught exception:', error);
		});

		// Bot config settings
		this.token = process.env.DISCORD_TOKEN;
		this.owner = process.env.OWNER_ID;
		this.colour = process.env.EMBED_COLOUR;

		const client = this;

		// Distube setup
		this.distube = new DisTube(client, {
			leaveOnEmpty: false,
			emptyCooldown: 60,
			leaveOnFinish: false,
			leaveOnStop: false,
			plugins: [
				new SoundCloudPlugin(),
				new SpotifyPlugin({
					emitEventsAfterFetching: true,
					api: {
						clientId: process.env.SPOTIFY_ID,
						clientSecret: process.env.SPOTIFY_SECRET,
					},
					//parallel: false,
				}),
			],
		});

		this.commands = new Collection();

		// Load handlers
		//? This is just an easy way of loading all the handlers in the handlers folder while passing the client.
		['commands', 'events', 'database'].forEach((x) =>
			require(`./handlers/${x}`)(client)
		);
	}

	// Shes Alive! (Maybe?)
	connect() {
		return super.login(this.token);
	}
}

module.exports = BotClient;
