const { readdirSync } = require('fs');
const { green, blue, magenta, red } = require('chalk');

/**
 * @description Loads all events in a recursive manner
 * @param {BotClient} client
 * @param {*} message
 */
module.exports = async (client, message) => {
	const startTime = Date.now();

	// Load Distube events
	//? We do this seperately because they must be attached to client.distube and not just client.
	readdirSync('./events/distube/').forEach((file) => {
		const event = require(`../events/distube/${file}`);
		let eventName = file.split('.')[0];
		client.distube.on(eventName, event.bind(null, client));
	});

	console.log(
		green('[SUCCESS]'),
		'Loaded all ' +
			magenta('events') +
			' in ' +
			magenta(Date.now() - startTime) +
			magenta('ms')
	);
};
