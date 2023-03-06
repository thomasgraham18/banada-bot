const { blue, red } = require('chalk');

module.exports = async (client, error) => {
	console.log(
		red(`[DISCONNECT] `) +
			blue('[INFO]: ') +
			client.user.tag +
			' ' +
			client.user.id +
			' '
	);
};
