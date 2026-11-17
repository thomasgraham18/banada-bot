const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

/**
 * @description Send a message/embed built from raw JSON
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName("embedjson")
    .setDescription("https://glitchii.github.io/embedbuilder/")
    // This posts arbitrary content as the bot, so keep it to moderators.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel to echo to")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("json")
        .setDescription("JSON input for Discord embed")
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages))
      return interaction.editReply("You do not have access to this command.");

    const channel = interaction.options.getChannel("channel", true);

    let payload;
    try {
      payload = JSON.parse(interaction.options.getString("json", true));
    } catch {
      return interaction.editReply("That is not valid JSON.");
    }
    if (!payload || typeof payload !== "object")
      return interaction.editReply("The JSON must be a message object.");

    try {
      // Never let pasted JSON ping @everyone / roles.
      await channel.send({ ...payload, allowedMentions: { parse: [] } });
      return interaction.editReply(`Sent to ${channel}.`);
    } catch (e) {
      console.error(e);
      return interaction.editReply(`Discord rejected that message: ${e.message}`);
    }
  },
};
