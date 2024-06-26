const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");

/**
 * @description Shuffle the queue
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the queue"),

  // Command execution
  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: false });

    const queue = client.distube.getQueue(interaction);

    // Check if queue is empty
    if (!queue)
      return interaction.editReply(`There is nothing in the queue right now!`);

    const { channel } = interaction.member.voice;

    // Check if user is in a voice channel
    if (!channel)
      return interaction.editReply("You are not in a voice channel!");

    // Make sure the bot is in the same channel as the user
    if (
      interaction.member.voice.channel !==
      interaction.guild.members.me.voice.channel
    )
      return interaction.editReply(
        "You are not in the same voice channel as me!"
      );

    await client.distube.shuffle(interaction);

    const embed = new EmbedBuilder()
      .setColor(client.colour)
      .setDescription(`🔀 | **Songs have been shuffled**`);

    interaction.editReply({ embeds: [embed] });
  },
};
