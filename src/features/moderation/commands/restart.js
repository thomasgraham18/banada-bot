const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the bot if it becomes unresponsive"),

  async execute(interaction, client) {

    // Stop first: leaving the voice channel removes the queue, after which
    // distube.stop() would throw NO_QUEUE.
    const queue = client.distube.getQueue(interaction);
    if (queue) await queue.stop().catch(() => {});

    client.distube.voices.leave(interaction.guild);

    const embed = new EmbedBuilder()
      .setDescription(`🔁 | **Restarted, should be good to go**`)
      .setColor(client.colour);

    interaction.editReply({ embeds: [embed] });
  },
};
