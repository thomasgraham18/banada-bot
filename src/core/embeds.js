/**
 * Consistent response embeds. All take the client (for the panel colour) or
 * fall back to a default.
 *
 *   ctx.reply(embeds.success(client, "Starboard channel set to #stars"))
 */
const { EmbedBuilder } = require("discord.js");

const COLOURS = { success: 0x43b581, error: 0xed4245, warn: 0xfaa61a };

const brand = (client) => {
  const n = parseInt(client?.colour ?? "", 16);
  return Number.isNaN(n) ? 0x580476 : n;
};

const make = (colour, text, title) => {
  const embed = new EmbedBuilder().setColor(colour).setDescription(String(text).slice(0, 4096));
  if (title) embed.setTitle(String(title).slice(0, 256));
  return embed;
};

module.exports = {
  brand,
  info: (client, text, title) => make(brand(client), text, title),
  success: (client, text, title) => make(COLOURS.success, `✅ ${text}`, title),
  error: (client, text, title) => make(COLOURS.error, `❌ ${text}`, title),
  warn: (client, text, title) => make(COLOURS.warn, `⚠️ ${text}`, title),
  COLOURS,
};
