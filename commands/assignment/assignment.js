const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: (new SlashCommandBuilder()
        .setName('assignment')
        .setDescription('Assignment CRUD')
        .addSubcommand(subcommand => subcommand
            .setName('add')
            .setDescription('Add an assignment')
            .addStringOption(option => option //name, course, due
                .setName('name')
                .setDescription('The name of the assignment')
                .setRequired(true)
            )
            .addStringOption(option => option
                .setName('course')
                .setDescription('The course the assignment is for')
                .setRequired(true)
            )
            .addStringOption(option => option
                .setName('due')
                .setDescription('The due date of the assignment')
                .setRequired(true)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('edit')
            .setDescription('Edit an assignment')
            .addNumberOption(option => option
                .setName('id')
                .setDescription('The id of the assignment')
                .setRequired(true)
                .setAutocomplete(true)
            )
            .addStringOption(option => option //name, course, due
                .setName('name')
                .setDescription('The name of the assignment')
                .setRequired(false)
            )
            .addStringOption(option => option
                .setName('course')
                .setDescription('The course the assignment is for')
                .setRequired(false)
            )
            .addStringOption(option => option
                .setName('due')
                .setDescription('The due date of the assignment')
                .setRequired(false)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('remove')
            .setDescription('Remove an assignment')
            .addNumberOption(option => option
                .setName('id')
                .setDescription('The id of the assignment')
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('view')
            .setDescription('View a specific assignment')
            .addNumberOption(option => option
                .setName('id')
                .setDescription('The id of the assignment')
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('list')
            .setDescription('View all assignments')
        )
    ),

    async execute(interaction, client) {
        const subcommand = interaction.options.getSubcommand();

        //all view and remove are simpler

        if (subcommand === 'list') {
            const assignments = await client.getAllAssignments();

            console.log(assignments)

            const embed = new EmbedBuilder()
                .setTitle('Assignments')
                .setColor(0x00FF00)
                .setDescription(assignments.map(assignment => {
                    return `
                    🔢 **ID:** ${assignment.ID}
                    📌 **Assignment:** ${assignment.data.name}
                    🎓 **Course:** ${assignment.data.course}
                    🕒 **Due:** ${assignment.data.due}`
                }).join('\n'))
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            
        }

        if (subcommand === 'view') {
            //view a specific assignment
            const id = interaction.options.getNumber('id');
            const assignment = await client.getAssignment(interaction, id);
            console.log(assignment);

            const embed = new EmbedBuilder()
                .setTitle('Assignment')
                .setColor(0x00FF00)
                .setDescription(
                    `📌 **Assignment:** ${assignment.name}
                    🎓 **Course:** ${assignment.course}
                    🕒 **Due: ${assignment.due}`)
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed] });
        }

        if (subcommand === 'remove') {
            //remove an assignment
            const id = interaction.options.getNumber('id');
            await client.removeAssignment(interaction, id);

            const embed = new EmbedBuilder()
                .setTitle('Assignment Removed')
                .setColor(0x00FF00)
                .setDescription(`Removed assignment: ${id}`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }

        //add, edit are more complicated

        if (subcommand === 'add') {
            //add an assignment
            const name = interaction.options.getString('name');
            const course = interaction.options.getString('course');
            const due = interaction.options.getString('due');

            await client.addAssignment(interaction, name, course, due);

            if(interaction.replied) return;

            const embed = new EmbedBuilder()
                .setTitle('Assignment Added')
                .setColor(0x00FF00)
                .setDescription(
                `💡 New Assignment Alert! 📝

                📌 Assignment: ${name}
                🎓 Course: ${course}
                🕒 Due: ${due} 
                
                Get to work! 💪🏼💻🚀
                `)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }

        if (subcommand === 'edit') {
            //edit an assignment
            const id = interaction.options.getNumber('id');
            const name = interaction.options.getString('name') ?? null;
            const course = interaction.options.getString('course') ?? null;
            const due = interaction.options.getString('due') ?? null;

            await client.editAssignment(interaction, id, name, course, due);
            const assignment = await client.getAssignment(interaction, id);

            const embed = new EmbedBuilder()
                .setTitle('Assignment Edited')
                .setColor(0x00FF00)
                .setDescription(`Edited assignment: ${assignment.name} • ${assignment.course} (${assignment.due})`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }
    }   
}