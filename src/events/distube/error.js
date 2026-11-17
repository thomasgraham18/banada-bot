const { EmbedBuilder } = require("discord.js");

/**
 * Emitted when DisTube hits an error while playing.
 * DisTube v5 signature: (error, queue, song). In v4 it was (channel, error).
 * @param {BotClient} client
 * @param {Error} error
 * @param {Queue} queue
 * @param {Song} [song]
 */
module.exports = async (client, error, queue, song) => {
  console.error(`[DisTube] Error in guild ${queue?.id ?? "unknown"}:`, error);

  const embed = new EmbedBuilder()
    .setTitle("** ⁉️ Error occured **")
    .setColor(0xff0000)
    .setDescription(
      `${song?.name ? `**${song.name}**\n` : ""}${String(
        error?.message ?? error
      ).slice(0, 3900)}`
    );

  await queue?.textChannel?.send({ embeds: [embed] }).catch(() => {});
};
