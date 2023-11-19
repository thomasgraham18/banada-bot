const { green, blue, magenta } = require('chalk');
const { EmbedBuilder } = require('discord.js'); // Make sure to import the correct classes

module.exports = async (client) => {
	console.log(
		blue('[INFO] ') + magenta(client.user.tag) + green(' is online!')
	);

	const activities = [
		'thomasg.ca',
		'thomasg.ca/knowledge',
		'/autoplay',
		'/help',
		'/play [song]',
		'/search [song]',
		'Spotify, Soundcloud, YouTube',
	];

	// Every 30 minutes
	setInterval(async () => {
		// Set and change presence
		client.user.setPresence({
			activities: [
				{
					name: `${
						activities[
							Math.floor(Math.random() * activities.length)
						]
					}`,
					type: 4,
				},
			],
			status: 'online',
		});
	}, 1800000);
};
