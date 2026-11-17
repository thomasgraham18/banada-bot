const { SlashCommandBuilder } = require("discord.js");
const playRequest = require("../../../utils/playRequest");

const BANADA_PLAYLIST =
  "https://open.spotify.com/playlist/3R2g83qZT9APj2YpVX3HIv";

/**
 * @description Plays the Banada playlist
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("banada")
    .setDescription("Plays the Banada playlist"),

  async execute(interaction, client) {
    return playRequest(interaction, client, BANADA_PLAYLIST);
  },
};
