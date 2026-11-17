/**
 * logAction(guild, type, data): posts an embed to the configured log channel.
 *
 *   type "punishment" | "honeypot" | "filter" | anything moderation-ish -> modlog
 *   type "join" | "leave"                                                  -> joinlogs
 *
 * Does nothing when the channel isn't configured or the bot can't post there.
 */
const { EmbedBuilder } = require("discord.js");
const config = require("./config");
const { safeSend } = require("./ui");
const embeds = require("./embeds");

const JOIN_TYPES = new Set(["join", "leave"]);

/**
 * @param {import("discord.js").Guild} guild
 * @param {string} type
 * @param {{ title?: string, description?: string, fields?: {name,value,inline?}[], colour?: number, user?: import("discord.js").User, embed?: EmbedBuilder }} data
 */
async function logAction(guild, type, data = {}) {
  const key = JOIN_TYPES.has(type) ? config.KEYS.JOINLOG_CHANNEL : config.KEYS.MODLOG_CHANNEL;
  const channelId = config.get(guild.id, key);
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel) return null;

  const embed =
    data.embed ??
    new EmbedBuilder()
      .setColor(data.colour ?? embeds.brand(guild.client))
      .setTitle((data.title ?? type).slice(0, 256))
      .setTimestamp();
  if (!data.embed) {
    if (data.description) embed.setDescription(String(data.description).slice(0, 4096));
    if (data.fields?.length) embed.addFields(data.fields.slice(0, 25).map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value || "—").slice(0, 1024), inline: f.inline ?? true })));
    if (data.user) embed.setAuthor({ name: data.user.tag ?? data.user.username, iconURL: data.user.displayAvatarURL() }).setFooter({ text: `User ID: ${data.user.id}` });
  }
  return safeSend(channel, { embeds: [embed], allowedMentions: { parse: [] } });
}

module.exports = { logAction };
