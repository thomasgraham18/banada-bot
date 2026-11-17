const { EmbedBuilder } = require("discord.js");
const announce = require("../../utils/announce");
const player = require("../../utils/player");

/**
 * Emitted when a playlist is added to the queue.
 * @param {BotClient} client
 * @param {Queue} queue
 * @param {Playlist} playlist
 */
module.exports = async (client, queue, playlist) => {
  const title = playlist.url
    ? `[${playlist.name}](${playlist.url})`
    : playlist.name;

  const embed = new EmbedBuilder()
    .setDescription(
      `**Queued • ${title}** \`${playlist.formattedDuration}\` (${
        playlist.songs.length
      } tracks) • ${playlist.user ?? ""}`
    )
    .setColor(client.colour);

  await announce(queue, playlist, embed);

  // Update the "up next" list on the player panel.
  player.refresh(client, queue.id);
};
