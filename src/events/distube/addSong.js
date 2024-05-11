const { EmbedBuilder } = require("discord.js");
const { Database } = require("st.db");

const DBMessage = new Database("./models/message.json", {
  databaseInObject: true,
});

/**
 * Emited when a song is added to the queue.
 * @param {BotClient} client
 * @param {Queue} client
 * @param {Song} song
 */
module.exports = async (client, queue, song) => {
  const data = await DBMessage.get(queue.textChannel.guild.id);

  const msg = await queue.textChannel.messages.cache.get(data.message_id);

  const embed = new EmbedBuilder()
    .setDescription(
      `**Queued • [${song.name}](${song.url})** \`${song.formattedDuration}\` • ${song.user}`
    )
    .setColor(client.colour);

  await msg.edit({ content: msg.content, embeds: [embed] });
};
