const { EmbedBuilder } = require("discord.js");

/**
 * Emited when the channel is empty.
 * @param {BotClient} client
 * @param {Queue} client
 */
module.exports = async (client, queue) => {
  const embed = new EmbedBuilder()
    .setColor(client.colour)
    .setDescription(`**Channel is Empty!**`);

  queue.textChannel.send({ embeds: [embed] });
};
