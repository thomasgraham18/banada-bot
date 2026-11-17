const { SlashCommandBuilder } = require("discord.js");
const player = require("../../../utils/player");

/**
 * @description Brings the player panel to the bottom of the chat.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Shows the player with the current song."),

  async execute(interaction, client) {
    const queue = client.distube.getQueue(interaction.guildId);

    if (!queue) return interaction.editReply(`There is nothing playing.`);

    // Re-post the panel in this channel, below everything else.
    queue.textChannel = interaction.channel;
    await player.show(client, queue, { forceNew: true });

    // The panel is the answer, so remove the "thinking..." placeholder.
    await interaction.deleteReply().catch(() => {});
  },
};
