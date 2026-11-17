/**
 * Shows an embed for something that was just queued.
 *
 * The play commands pass `metadata: { interaction }` to distube.play(), so the
 * "Searching..." reply can be edited into the result. If that is not possible
 * (no interaction, or its 15 minute token expired) the embed is sent to the
 * queue's text channel instead.
 *
 * @param {Queue} queue
 * @param {{ metadata?: { interaction?: import("discord.js").ChatInputCommandInteraction } }} item Song or Playlist
 * @param {import("discord.js").EmbedBuilder} embed
 */
module.exports = async function announce(queue, item, embed) {
  const interaction = item.metadata?.interaction;

  if (interaction) {
    try {
      await interaction.editReply({ content: "", embeds: [embed] });
      return;
    } catch {
      // Fall through to a normal channel message.
    }
  }

  await queue.textChannel?.send({ embeds: [embed] }).catch(() => {});
};
