/**
 * Emited when a channel is deleted.
 * @param {BotClient} client
 * @param {*} channel
 * @returns
 */
module.exports = async (client, channel) => {
  if (channel.type == 2) {
    if (channel.members.has(client.user.id)) {
      const queue = client.distube.getQueue(channel.guild.id);
      if (queue) {
        client.distube.stop(channel);
        return;
      }
    }
  }

  if (channel.type == 13) {
    if (channel.members.has(client.user.id)) {
      const queue = client.distube.getQueue(channel.guild.id);
      if (queue) {
        client.distube.stop(channel);
        return;
      }
    }
  }
};
