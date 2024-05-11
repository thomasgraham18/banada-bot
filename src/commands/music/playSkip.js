const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

/**
 * @description Play a song and skip the current song
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("playskip")
    .setDescription("Play a song and skip the current song")
    .addStringOption((option) =>
      option
        .setName("search")
        .setDescription("The song to play")
        .setRequired(true)
    ),
  // Command execution
  async execute(interaction, client) {
    try {
      if (interaction.options.getString("search")) {
        await interaction.reply(
          `🔍 **Searching...** \`${interaction.options.getString("search")}\``
        );

        const message = await interaction.fetchReply();

        //? We do this so we can edit the message later
        await client.createPlay(interaction, message.id);

        const { channel } = interaction.member.voice;

        // Check if user is in a voice channel
        if (!channel)
          return interaction.editReply("You are not in a voice channel!");

        if (
          !channel
            .permissionsFor(interaction.guild.members.me)
            .has(PermissionsBitField.Flags.Connect)
        )
          return interaction.editReply(
            `I don't have permission \`CONNECT\` to ${channel.name}!`
          );
        if (
          !channel
            .permissionsFor(interaction.guild.members.me)
            .has(PermissionsBitField.Flags.Speak)
        )
          return interaction.editReply(
            `I don't have permission to \`SPEAK\` in ${channel.name}!`
          );

        try {
          const string = interaction.options.getString("search");

          const options = {
            member: interaction.member,
            textChannel: interaction.channel,
            interaction,
            skip: true,
          };

          await client.distube.play(
            interaction.member.voice.channel,
            string,
            options
          );
        } catch (e) {
          console.log(e);
        }
      }
    } catch (e) {
      console.log(e);
    }
  },
};
