const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");

/**
 * @description Move a song in the queue
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("move")
    .setDescription("Move a song in queue")
    .addIntegerOption((option) =>
      option
        .setName("queue")
        .setMinValue(1)
        .setDescription("The queue of the song")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("position")
        .setMinValue(1)
        .setDescription("The position in queue want to move too.")
        .setRequired(true)
    ),
  // Command execution
  async execute(interaction, client) {

    const tracks = interaction.options.getInteger("queue");
    const position = interaction.options.getInteger("position");

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

    // Index 0 is the song that is currently playing.
    if (tracks === 0)
      return interaction.editReply(`Cannot move song, it's already playing.`);
    if (position === 0)
      return interaction.editReply(
        `Cannot move to this position, song already playing.`
      );
    if (tracks < 0 || tracks >= queue.songs.length)
      return interaction.editReply(`Queue | Song not found.`);
    if (position < 0 || position >= queue.songs.length)
      return interaction.editReply(`Position | Song not found.`);

    // Remove exactly one song, then re-insert it at the new index.
    // (The old code called splice(tracks), which deleted the rest of the queue.)
    const [song] = queue.songs.splice(tracks, 1);
    queue.songs.splice(position, 0, song);

    const embed = new EmbedBuilder()
      .setDescription(`**Moved • [${song.name}](${song.url})** to ${position}`)
      .setColor(client.colour);

    interaction.editReply({ embeds: [embed] });
  },
};
