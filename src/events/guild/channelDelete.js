/**
 * Emitted when a channel is deleted. If it was the voice channel the bot was
 * playing in, drop the queue and leave.
 * @param {BotClient} client
 * @param {import("discord.js").GuildChannel} channel
 */
module.exports = async (client, channel) => {
  if (!channel.isVoiceBased?.()) return;

  const queue = client.distube.getQueue(channel.guild.id);
  if (queue && queue.voiceChannel?.id === channel.id) {
    client.distube.voices.leave(channel.guild);
  }
};
