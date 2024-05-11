const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagBits,
  Embed,
} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user from the discord server")
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
    const { channel, options } = interaction;

    const target = options.getUser("target");
    let reason = options.getString("reason");
    const userToKick = await interaction.guild.members.fetch(target.id);

    const err0Embed = new EmbedBuilder()
      .setTitle("** Error ⁉️ **")
      .setColor(0xff0000)
      .setDescription(`You do not have the required permissions`);

    const err1Embed = new EmbedBuilder()
      .setTitle("** Error ⁉️ **")
      .setColor(0xff0000)
      .setDescription(`Targer user has a higher or equal role`);

    if (!interaction.member.roles.cache.has("850059052440485928"))
      return interaction.reply({ embeds: [err0Embed], ephemeral: true });

    if (
      userToKick.roles.highest.position >=
      interaction.member.roles.highest.position
    )
      return interaction.reply({ embeds: [err1Embed], ephemeral: true });

    if (reason == null) reason = "no reason";

    await userToKick.kick(reason);

    const embed = new EmbedBuilder()
      .setDescription(
        `Succesfully kicked **${target}** with the reason: **${reason}**`
      )
      .setColor(client.colour);

    await interaction.reply({ embeds: [embed] });
  },
};
