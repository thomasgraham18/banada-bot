const { SlashCommandBuilder } = require("discord.js");
const playRequest = require("../../../utils/playRequest");

/**
 * @description Play a song and skip the current song
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("playskip")
    .setDescription("Play a song and skip the current song")
    .addStringOption((option) =>
      option
        .setName("search")
        .setDescription("Song name or URL (YouTube, Spotify, SoundCloud...)")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction, client) {
    const query = interaction.options.getString("search", true);
    return playRequest(interaction, client, query, { skip: true });
  },
};
