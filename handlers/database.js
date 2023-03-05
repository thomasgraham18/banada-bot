const { Database } = require('st.db');
const { green } = require('chalk');
const dayjs  = require('dayjs');
console.log(dayjs().format());

/**
 * @description Load database methods
 * @param {BotClient} client
 */
module.exports = async (client) => {
	console.log(green('[INFO]') + green(`Database Loaded`));

	client.createPlay = async function (interaction, message) {
		const db = new Database('./models/message.json', {
			databaseInObject: true
		});
		await db.set(interaction.guild.id, {
			channel_id: interaction.channel.id,
			message_id: message,
		});
	};

	client.addAssignment = async function (interaction, name, course, due) {
		const db = new Database('./models/assignments.json', {
			databaseInObject: true
		});

		const results = await db.all();

		let i = 0;

		results.forEach(
			e => {
				i = e.ID > i ? e.ID : i;
			}
		);

		let date = dayjs(due);

		if (date.isValid()) {
			if(date.year() == 2001) {
				//then geto ut of here 
				date = date.set('year', dayjs().year())
				console.log(dayjs().year());
				console.log(date);
			}
		}

		//let date = dayjs(due).toDate();

		if(date == "Invalid Date") {
			await interaction.reply({
				content: 'Invalid Date',
				ephemeral: true
			});
			return;
		}

		console.log("[INFO] Adding Assignment, Future ID: " + (i+1));

		await db.set(++i, {
			name: name,
			course: course,
			due: date
		});
	};

	client.getAllAssignments = async function () {
		const db = new Database('./models/assignments.json', {
			databaseInObject: true
		});

		const results = await db.all();

		return results;
	};

	client.getAssignment = async function (interaction, id) {
		const db = new Database('./models/assignments.json', {
			databaseInObject: true
		});

		const results = await db.get(id.toString());

		return results;
	};

	client.deleteAssignment = async function (interaction, id) {
		const db = new Database('./models/assignments.json', {
			databaseInObject: true
		});

		await db.delete(id.toString());
	};

	client.editAssignment = async function (interaction, id, name, course, due) {
		//edit assignment
		const db = new Database('./models/assignments.json', {
			databaseInObject: true	
		});

		const assignment = db.get(id.toString());

		if(name == null) name = assignment.name;
		if(course == null) course = assignment.course;
		if(due == null) due = assignment.due;

		await db.set(id.toString(), {
			name: name,
			course: course,
			due: due
		});
	};

	client.interval = null;

	client.clearInterval = async function (interval) {
		clearInterval(interval);
	};
};
