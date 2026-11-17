/**
 * /sticker extract: every sticker in this server as zip file(s). See ../extract.js.
 */
const { SlashCommandBuilder } = require("discord.js");
const { defineCommand } = require("../../../core");
const { extract } = require("../extract");

module.exports = defineCommand({
  data: new SlashCommandBuilder()
    .setName("sticker")
    .setDescription("Server sticker tools")
    .addSubcommand((s) => s.setName("extract").setDescription("Send every sticker in this server as a zip file")),
  handlers: {
    // Downloads can take a while: the default (public) defer covers it.
    extract: { gate: "Administrator", run: (interaction, ctx) => extract(interaction, ctx, "sticker") },
  },
});
