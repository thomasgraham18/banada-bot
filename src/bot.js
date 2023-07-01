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
			youtubeCookie: "YSC=wSSTyyWAoQA; VISITOR_INFO1_LIVE=CHGA0dCDOJg; LOGIN_INFO=AFmmF2swRQIgDNY9KThAZtHIBdZSM3Whe7zXBgqyFgYS3J8pwgKkMisCIQDHbNTMsLWRwAd99dv5NNvdLSzJyYpYY0OibUWJ7hLG9w:QUQ3MjNmeFJBdjJmZUtjWm40b2dlWkVGbUFwaEpibmFTY3ZBdlYyOU1oSVpsV2xZWWgxZlF2ZGtLaDMzN01sZzJuNklCMHdQTEU2MlVDaFVhVWJIZ3FRcmxzZWN1ZFBRZDZucTdIYWFmeTlWeW5uNHVYMHh2U3hKNXFHRDJpSElya2FMR2lpd0NGaEs1cHFXalRqZ3Y4SlNvbUlGR2dxZ3RR; PREF=tz=America.Halifax&f6=40000000&f5=20000&f7=100; DEVICE_INFO=ChxOekU0TmpjM05UQTNOems0TkRjNU5qZzVNZz09ENub8p0GGNub8p0G; wide=0; SID=XwiUht6yTAeqtg4pCl67Kcty_cwb5_YhWCi8I735Si3Lygt5Hmh4uEHDJcKT2C85tPEYAQ.; __Secure-1PSID=XwiUht6yTAeqtg4pCl67Kcty_cwb5_YhWCi8I735Si3Lygt5XiOpFxV9Ufq2OKripc483w.; __Secure-3PSID=XwiUht6yTAeqtg4pCl67Kcty_cwb5_YhWCi8I735Si3Lygt54PjolVjI8K0imkq5S4LmVg.; HSID=ANy-SQoo8wWUb7kM7; SSID=As7gHp5jQJbWB-7zT; APISID=dZZpjXHELu41V3GK/A8iW9Tcib5flvnuuu; SAPISID=PhC_pNXmVX33JSNH/AoGPp_q5AuVKHCHlD; __Secure-1PAPISID=PhC_pNXmVX33JSNH/AoGPp_q5AuVKHCHlD; __Secure-3PAPISID=PhC_pNXmVX33JSNH/AoGPp_q5AuVKHCHlD; SIDCC=AP8dLtyF86AXjnykL5TZtLQEaBDDTH8292hSTXMWlpDIaTA8bTW5KVB0K7o6ErUDLjMuDx_DLACA; __Secure-1PSIDCC=AP8dLtwH5G9-yXoEF9md1Ba9kW0TwRqF2zTBpavrMeozwm2GZcVgooKZegdMa1LsLrgpGVwZRyM; __Secure-3PSIDCC=AP8dLtxE7X4Aw9NyIIznfPv0rrRccsWeMaxsqoHB83E-XHYsLoOYOxxCKknhKxmLebW0sXxmQqVC",
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
	console.log(client.spotifyToggle)
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
		return new SpotifyPlugin({  });
	}
}
