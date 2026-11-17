const { EmbedBuilder } = require("discord.js");
const announce = require("../../utils/announce");
const player = require("../../utils/player");

/**
 * Emitted when a song is added to the queue.
 * @param {BotClient} client
 * @param {Queue} queue
 * @param {Song} song
 */
module.exports = async (client, queue, song) => {
  const embed = new EmbedBuilder()
    .setDescription(
      `**Queued • [${song.name}](${song.url})** \`${song.formattedDuration}\` • ${
        song.user ?? ""
      }`
    )
    .setColor(client.colour);

  await announce(queue, song, embed);

  // Update the "up next" list on the player panel.
  player.refresh(client, queue.id);
};
