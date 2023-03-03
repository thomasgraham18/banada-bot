const { green, blue, magenta } = require('chalk');

/**
 * Emited when the bot is ready.
 * @param {BotClient} client
 */
module.exports = async (client) => {
	console.log(
		blue('[INFO] ') + magenta(client.user.tag) + green(' is online!')
	);

	const activities = [`Always be coding!`, `WMAD 2023`];

	setInterval(() => {
		client.user.setPresence({
			activities: [
				{
					name: `${
						activities[
							Math.floor(Math.random() * activities.length)
						]
					}`,
					type: 2,
				},
			],
			status: 'online',
		});
	}, 15000);
};
