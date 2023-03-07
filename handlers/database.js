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

	client.addAssignment = async function (interaction, name, course, due) {
		const db = new Database('./models/assignments.json', {
			databaseInObject: true
		});

		const assignments = await db.all();

		let highestKey = 0;

		assignments.forEach(
			assignment => {
				highestKey = 
					assignment.ID > highestKey 
					? assignment.ID 
					: highestKey;
			}
		);

		if(!due.isValid()) {
			await interaction.reply({
				content: `**Invalid date!**\n*Tip: You can use the following formats:*\n> March 1
				> 03/01
				> March 1 2023
				> 03/01/2023
				> 03-01`,
				ephemeral: true
			});
			return;
		}
		
		if(name.length > 50) {
			await interaction.reply({
				content: `**Assignment name is too long!**\n*Please don't use more than 50 characters*\n*You used ${name.length} characters*`,
				ephemeral: true
			});
			return;
		}

		if(course.length > 50) {
			await interaction.reply({
				content: `**Course name is too long!**\n*Please don't use more than 50 characters*\n*You used ${course.length} characters*`,
				ephemeral: true
			});
			return;
		}

		await db.set(++highestKey, {
			name: name,
			course: course,
			due: due
		});
	};

	client.editAssignment = async function (interaction, id, name, course, due) {
		//edit assignment
		const db = new Database('./models/assignments.json', {
			databaseInObject: true	
		});

		const assignment = db.get(id.toString());

		if(!name) name = assignment.name;
		if(!course) course = assignment.course;
		if(!due.isValid()) due = assignment.due;

		if(!due.isValid()) {
			await interaction.reply({
				content: `**Invalid date!**\n*Tip: You can use the following formats:*\n> March 1
				> 03/01
				> March 1 2023
				> 03/01/2023
				> 03-01`,
				ephemeral: true
			});
			return;
		}

		if(name.length > 50) {
			await interaction.reply({
				content: `**Assignment name is too long!**\n*Please don't use more than 50 characters*\n*You used ${name.length} characters*`,
				ephemeral: true
			});
			return;
		}

		if(course.length > 50) {
			await interaction.reply({
				content: `**Course name is too long!**\n*Please don't use more than 50 characters*\n*You used ${course.length} characters*`,
				ephemeral: true
			});
			return;
		}

		console.log("due: " + due);
		console.log("assignment.due: " + assignment.due)

		await db.set(id.toString(), {
			name: name,
			course: course,
			due: dayjs(due)
		});
	};

	client.interval = null;

	client.clearInterval = async function (interval) {
		clearInterval(interval);
	};
};