const { SlashCommandBuilder } = require("discord.js");
const playRequest = require("../../../utils/playRequest");

/**
 * @description Play a song from any type of media
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song from any type of media")
    .addStringOption((option) =>
      option
        .setName("search")
        .setDescription("Song name or URL (YouTube, Spotify, SoundCloud...)")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction, client) {
    const query = interaction.options.getString("search", true);
    return playRequest(interaction, client, query);
  },
};
