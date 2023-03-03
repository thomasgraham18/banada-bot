const { Database } = require('st.db');
const { green } = require('chalk');

/**
 * @description Load database methods
 * @param {BotClient} client
 */
module.exports = async (client) => {
	console.log(green('[INFO]') + green(`Database Loaded`));

	client.createPlay = async function (interaction, message) {
		const db = new Database('./models/message.json', {
			databaseInObject: true,
		});
		await db.set(interaction.guild.id, {
			channel_id: interaction.channel.id,
			message_id: message,
		});
	};

	client.interval = null;

	client.clearInterval = async function (interval) {
		clearInterval(interval);
	};
};
