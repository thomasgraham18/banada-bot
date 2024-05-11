const { EmbedBuilder } = require("discord.js");
const { Database } = require("st.db");

const DBMessage = new Database("./models/message.json", {
  databaseInObject: true,
});

/**
 * @description Emitted when a playlist is added to the queue.
 * @param {BotClient} client
 * @param {Queue} client
 * @param {*} playlist
 */
module.exports = async (client, queue, playlist) => {
  const data = await DBMessage.get(queue.textChannel.guild.id);
  const msg = await queue.textChannel.messages.cache.get(data.message_id);
  const embed = new EmbedBuilder()
    .setDescription(
      `**Queued • [${playlist.name}](${playlist.url})** \`${queue.formattedDuration}\` (${playlist.songs.length} tracks) • ${playlist.user}`
    )
    .setColor(client.colour);

  await msg.edit({ content: msg.content, embeds: [embed] });
};
