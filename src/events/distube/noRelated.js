const { EmbedBuilder } = require("discord.js");

/**
 * Emitted when autoplay is on but no related song could be found
 * (for example after a SoundCloud or Spotify-only track).
 * @param {BotClient} client
 * @param {Queue} queue
 */
module.exports = async (client, queue) => {
  const embed = new EmbedBuilder()
    .setColor(client.colour)
    .setDescription("♾️ | **Autoplay couldn't find a related song.**");

  await queue.textChannel?.send({ embeds: [embed] }).catch(() => {});
};
