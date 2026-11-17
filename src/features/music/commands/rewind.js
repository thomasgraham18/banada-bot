const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");

/**
 * @description Rewind the current song
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("Rewind the current song")
    .addIntegerOption((option) =>
      option
        .setName("seconds")
        .setMinValue(1)
        .setDescription("The amount of seconds to rewind the song by")
    ),
  // Command execution
  async execute(interaction, client) {

    const value = interaction.options.getInteger("seconds");

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

    // Default to 10 seconds; never seek before the start of the song.
    const seconds = Math.abs(value ?? 10);
    queue.seek(Math.max(0, queue.currentTime - seconds));

    const embed = new EmbedBuilder()
      .setDescription(`⏮ | **Rewound to:** \`${queue.formattedCurrentTime}\``)
      .setColor(client.colour);

    return interaction.editReply({ embeds: [embed] });
  },
};
