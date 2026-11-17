const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");

/**
 * @description Change the volume
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Change the volume")
    .addIntegerOption((option) =>
      option
        .setName("volume")
        .setMinValue(0)
        .setMaxValue(200)
        .setDescription("The desired volume")
        .setRequired(false)
    ),

  // Command execution
  async execute(interaction, client) {

    const volume = interaction.options.getInteger("volume");

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

    // If no volume is provided, return the current volume
    if (volume === null) {
      const embed = new EmbedBuilder()
        .setColor(client.colour)
        .setDescription(`Current **volume** : \`${queue.volume}\`%`);

      return interaction.editReply({ embeds: [embed] });
    }

    if (volume < 0 || volume > 200)
      return interaction.editReply(`Please provide a number between 0 and 200`);

    await queue.setVolume(volume);

    const embed = new EmbedBuilder()
      .setColor(client.colour)
      .setDescription(`🔊 | **Changed volume to:** \`${volume}\`%`);

    interaction.editReply({ embeds: [embed] });
  },
};
