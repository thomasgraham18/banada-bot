const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");

/**
 * @description Join the voice channel
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join the voice channel"),

  // Command execution
  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: false });

    const queue = client.distube.getQueue(interaction);
    if (queue)
      return interaction.editReply(`I am already playing in a voice channel.`);

    const { channel } = interaction.member.voice;

    // Check if user is in a voice channel
    if (!channel)
      return interaction.editReply(`You need to be in voice channel.`);

    await client.distube.voices.join(interaction.member.voice.channel);

    const embed = new EmbedBuilder()
      .setColor(client.colour)
      .setDescription(`🤟 | **Joined:** \`${channel.name}\``);

    interaction.editReply({ embeds: [embed] });
  },
};
