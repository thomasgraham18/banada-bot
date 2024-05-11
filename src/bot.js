const { Client, Events, GatewayIntentBits, Collection } = require('discord.js');
const config = require('./config.json');
const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { SpotifyPlugin } = require('@distube/spotify');
const { green } = require('chalk');
const fs = require('fs');

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
		this.token = config.DISCORD_TOKEN;
		this.owner = config.OWNER_ID;
		this.colour = config.EMBED_COLOUR;
		this.spotifyToggle = config.SPOTIFY_TOGGLE;
		this.spotifyID = config.SPOTIFY_ID;
		this.spotifySecret = config.SPOTIFY_SECRET;
		this.youtubeCookie = config.YOUTUBE_COOKIE;
		this.leaveOnEmpty = config.LEAVE_EMPTY;
		this.leaveOnEmptyTime = config.LEAVE_EMPTY_TIME;
		this.leaveOnFinish = config.LEAVE_FINISH;
		this.leaveStop = config.LEAVE_STOP;

		const client = this;

		// Distube setup
		this.distube = new DisTube(client, {
			youtubeCookie: JSON.parse(fs.readFileSync('cookie.json')),
			emptyCooldown: 60,
			leaveOnEmpty: false,
			leaveOnFinish: false,
			leaveOnStop: false,
			plugins: [new SoundCloudPlugin(), toggleSpotify(client)],
		});

		this.commands = new Collection();

		// Load handlers
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
	console.log(client.spotifyToggle);
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
