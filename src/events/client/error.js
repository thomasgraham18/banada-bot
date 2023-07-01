const { blue, red } = require('chalk');

module.exports = async (client, channel, error) => {
	console.log(
		red(`[ERROR] `) +
			'An error event was sent by Discord.js: \n' +
			blue('[INFO]: ') +
			client.user.tag +
			' ' +
			client.user.id +
			' ' +
			blue('[ERROR]: ') +
			error
	);
		console.log(channel)
	// const embed = new EmbedBuilder()
	// .setTitle("** ⁉️ Error occured **")
	// .setColor(0xFF0000)
	// .setDescription(`${error}`);

	// channel.send({ embeds: [embed] });
};
