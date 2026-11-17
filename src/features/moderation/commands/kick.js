const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const errorEmbed = (text) =>
  new EmbedBuilder()
    .setTitle("** Error ⁉️ **")
    .setColor(0xff0000)
    .setDescription(text);

module.exports = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user from the discord server")
    // Discord hides the command from members without Kick Members.
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("User to be kicked")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason for the kick")
    ),

  async execute(interaction, client) {
    const target = interaction.options.getUser("target", true);
    const reason = interaction.options.getString("reason") ?? "no reason";

    // Defence in depth: server admins can override default command permissions.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers))
      return interaction.editReply({
        embeds: [errorEmbed("You do not have the required permissions")],
      });

    const member = await interaction.guild.members
      .fetch(target.id)
      .catch(() => null);
    if (!member)
      return interaction.editReply({
        embeds: [errorEmbed("That user is not in this server")],
      });

    if (
      member.roles.highest.position >= interaction.member.roles.highest.position
    )
      return interaction.editReply({
        embeds: [errorEmbed("Target user has a higher or equal role")],
      });

    if (!member.kickable)
      return interaction.editReply({
        embeds: [errorEmbed("I don't have permission to kick that user")],
      });

    await member.kick(reason);

    const embed = new EmbedBuilder()
      .setDescription(
        `Successfully kicked **${target}** with the reason: **${reason}**`
      )
      .setColor(client.colour);

    return interaction.editReply({ embeds: [embed] });
  },
};
