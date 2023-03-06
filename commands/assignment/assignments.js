const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");
const dayjs = require("dayjs");
const duration = require("dayjs/plugin/duration");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const advancedFormat = require("dayjs/plugin/advancedFormat");
const humanize = require("dayjs/plugin/relativeTime");

// TODO: ADD MORE ERROR CATCHING FOR USER INPUT (BAD DATA)

module.exports = {
    // Command structure: 
    // /assignments [action] <name> <course> <due>
    // actions are subcommands
  data: new SlashCommandBuilder()
    .setName("assignments")
    .setDescription("Assignment CRUD")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add an assignment")
        .addStringOption((option) =>
          option //name, course, due
            .setName("name")
            .setDescription("The name of the assignment")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("course")
            .setDescription("The course the assignment is for")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("due")
            .setDescription("The due date of the assignment")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("edit")
        .setDescription("Edit an assignment")
        .addNumberOption((option) =>
          option
            .setName("id")
            .setDescription("The id of the assignment")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option //name, course, due
            .setName("name")
            .setDescription("The name of the assignment")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("course")
            .setDescription("The course the assignment is for")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("due")
            .setDescription("The due date of the assignment")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove an assignment")
        .addNumberOption((option) =>
          option
            .setName("id")
            .setDescription("The id of the assignment")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View a specific assignment")
        .addNumberOption((option) =>
          option
            .setName("id")
            .setDescription("The id of the assignment")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("View all assignments")
    ),

  // TODO: CHANGE "REMOVE" TO "COMPLETE".

  async execute(interaction, client) {
    // ? The subcommand is the action we're doing (add/view/all/remove/edit)
    const subcommand = interaction.options.getSubcommand();

    dayjs.extend(customParseFormat);
    dayjs.extend(advancedFormat);
    //all view and remove are simpler

    if (subcommand === "list") {

      const assignments = await client.getAllAssignments();

      const embed = new EmbedBuilder()
        .setTitle("Current Assignments")
        .setColor(0xA020F0)
        .setDescription(
          assignments
            .map((assignment) => {
                const due = dayjs(assignment.data.due);

              return `🔢 **ID:** ${assignment.ID}
                    📌 **Assignment:** 
                    ${assignment.data.name}
                    🎓 **Course:** ${assignment.data.course}
                    🕒 **Due:** <t:${due.format('X')}:R>
                    
                    `;
            })
            .join("\n")
        )
        .setTimestamp();

      //🕒 **Due:** ${dayjs(assignment.data.due)
      //    .format('MMMM Do')}

      await interaction.reply({ embeds: [embed] });
    }

    if (subcommand === "view") {
      //view a specific assignment
      const id = interaction.options.getNumber("id");
      const assignment = await client.getAssignment(interaction, id);
      const due = dayjs(assignment.due)

      const embed = new EmbedBuilder()
        .setTitle(`🚀🎉📝 Hey there! Check out the new assignment`)
        .setColor(0xA020F0)
        .setDescription(
          `📌 **Assignment:** ${assignment.name}
                    🎓 **Course:** ${assignment.course}
                    🕒 **Due:** <t:${due.format('X')}:R>`
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    if (subcommand === "remove") {
      //remove an assignment
      const id = interaction.options.getNumber("id");
      const assignment = await client.getAssignment(interaction, id);
      const due = dayjs(assignment.due)
      await client.deleteAssignment(interaction, id);

      const embed = new EmbedBuilder()
        .setTitle("🎉 Congratulations! **Assignment Completed!** 🎉")
        .setColor(0xC70039 )
        .setDescription(`

        📌 **Assignment:** ${assignment.name}
        🎓 **Course:** ${assignment.course}
        🕒 **Due:** <t:${due.format('X')}:R>
        
        👏🏼 Great work! You have successfully completed this assignment. 👏🏼
        Take a moment to celebrate your accomplishment! 
        🎉🎊💻🚀`)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    //add, edit are more complicated
    // TODO: TRIM ORDINAL NOTATION (LETTERS FROM DATE)
    if (subcommand === "add") {
      //add an assignment
      const name = interaction.options.getString("name");
      const course = interaction.options.getString("course");
      const date = interaction.options.getString("due");

      let due = dayjs(date)

      if (due.isValid()) {
        if(due.year() != dayjs().year()) {
          console.log("TEST");
          //then geto ut of here 
          due = due.set('year', dayjs().year())
          console.log(due);
        }
      }
      
      await client.addAssignment(interaction, name, course, due);

      if (interaction.replied) return;

      const embed = new EmbedBuilder()
        .setTitle("💡 New Assignment Alert! 📝")
        .setColor(0x228B22)
        .setDescription(
          `
                📌 **Assignment:** ${name}
                🎓 **Course:** ${course}
                🕒 **Due:** <t:${due.format('X')}:R> 
                
                Get to work! 💪🏼💻🚀
                `
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    // TODO: TRIM ORDINAL NOTATION (LETTERS FROM DATE)
    if (subcommand === "edit") {
      //edit an assignment
      const id = interaction.options.getNumber("id");
      const name = interaction.options.getString("name") ?? null;
      const course = interaction.options.getString("course") ?? null;
      const date = interaction.options.getString("due") ?? null;

      let due = dayjs(date)

      if (due.isValid()) {
        if(due.year() != dayjs().year()) {
          console.log("TEST");
          //then geto ut of here 
          due = due.set('year', dayjs().year())
          console.log(due);
        }
      }

      await client.editAssignment(interaction, id, name, course, due);
      
      const assignment = await client.getAssignment(interaction, id);
      const daysJSdue = dayjs(assignment.due);

      const embed = new EmbedBuilder()
        .setTitle("🚀🎉📝 Hey there! Check out the updated assignment")
        .setColor(0xFFA500)
        .setDescription(
          `📌 **Assignment:** ${assignment.name}
          🎓 **Course:** ${assignment.course}
          🕒 **Due:** <t:${daysJSdue.format('X')}:R>`
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  },
};
