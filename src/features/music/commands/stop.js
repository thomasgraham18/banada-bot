const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");
const player = require("../../../utils/player");

/**
 * @description Stop the bot
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the bot"),

  // Command execution
  async execute(interaction, client) {

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

    // Nothing playing is fine: stop still succeeds.
    const queue = client.distube.getQueue(interaction);
    if (queue) await player.stop(client, queue);

    const embed = new EmbedBuilder()
      .setDescription(`🛑 | **Stopped:** \`${channel.name}\``)
      .setColor(client.colour);

    interaction.editReply({ embeds: [embed] });
  },
};
