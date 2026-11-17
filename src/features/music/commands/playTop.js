const { SlashCommandBuilder } = require("discord.js");
const playRequest = require("../../../utils/playRequest");

/**
 * @description Play a song at the top of the queue
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("playtop")
    .setDescription("Play a song at the top of the queue")
    .addStringOption((option) =>
      option
        .setName("search")
        .setDescription("Song name or URL (YouTube, Spotify, SoundCloud...)")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction, client) {
    const query = interaction.options.getString("search", true);
    return playRequest(interaction, client, query, { position: 1 });
  },
};
