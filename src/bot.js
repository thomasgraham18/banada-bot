const { Client, Events, GatewayIntentBits, Collection } = require('discord.js');
require('dotenv').config();
const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { SpotifyPlugin } = require('@distube/spotify');
const { green } = require('chalk');

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
		this.spotifyToggle = process.env.SPOTIFY_TOGGLE;
		this.spotifyID = process.env.SPOTIFY_ID;
		this.spotifySecret = process.env.SPOTIFY_SECRET;

		const client = this;

		// Distube setup
		this.distube = new DisTube(client, {
			leaveOnEmpty: false,
			emptyCooldown: 60,
			leaveOnFinish: false,
			leaveOnStop: false,
			plugins: [new SoundCloudPlugin(), toggleSpotify(client)],
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

function toggleSpotify(client) {
	if (client.spotifyToggle == 'true') {
		console.log(green('[Spotify]') + ' Spotify extra tracks enabled');
		return new SpotifyPlugin({
			emitEventsAfterFetching: true,
			api: {
				clientId: client.spotifyID,
				clientSecret: client.spotifySecret,
			},
		});
	} else {
		return new SpotifyPlugin({});
	}
}
