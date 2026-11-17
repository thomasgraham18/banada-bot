/**
 * Pin archive: copies pinned messages into an archive channel as embeds
 * (author, content, attachments, jump link), optionally unpinning them.
 *
 * - `/automation pins archive` archives every pin in the current channel.
 * - Automatically (channelPinsUpdate) once a channel has AUTO_ARCHIVE_AT or
 *   more pins. Discord's pin cap used to be 50 and is now higher; 50 is a
 *   threshold that works under both, so the channel never hits the wall.
 *
 * Archived message IDs are remembered, so a pin is never posted twice.
 */
const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { embeds, guard, UserError } = require("../../core");
const store = require("./db");

const AUTO_ARCHIVE_AT = 50;

/** Every pinned message, oldest first (fetchPins pages 50 at a time). */
async function fetchAllPins(channel) {
  const items = [];
  let before;
  for (let i = 0; i < 20; i++) {
    const page = await channel.messages.fetchPins({ before, limit: 50 });
    items.push(...page.items);
    if (!page.hasMore || !page.items.length) break;
    before = page.items.at(-1).pinnedTimestamp;
  }
  return items.map((p) => p.message).reverse();
}

/** The archive embed for one message. */
function archiveEmbed(message) {
  const embed = new EmbedBuilder()
    .setColor(embeds.brand(message.client))
    .setAuthor({ name: message.author?.tag ?? "Unknown user", iconURL: message.author?.displayAvatarURL?.() })
    .setTimestamp(message.createdAt)
    .setFooter({ text: `#${message.channel?.name ?? message.channelId}` });

  // Bot messages often have no content but an embed: fall back to its text.
  const text = message.content || message.embeds[0]?.description || "";
  if (text) embed.setDescription(text.slice(0, 4000));

  const attachments = [...message.attachments.values()];
  const image = attachments.find((a) => a.contentType?.startsWith("image/"));
  if (image) embed.setImage(image.url);
  const others = attachments.filter((a) => a !== image);
  if (others.length)
    embed.addFields({ name: "Attachments", value: others.map((a) => `[${a.name}](${a.url})`).join("\n").slice(0, 1024) });
  embed.addFields({ name: "Original", value: `[Jump to message](${message.url})` });
  return embed;
}

const running = new Set(); // channel IDs being archived (pin events come in bursts)

/**
 * Archives the pins of `channel`. Returns { archived, skipped, unpinned }.
 * Throws UserError when the archive isn't usable.
 */
async function archive(channel, settings = store.pins.get(channel.guildId)) {
  if (!settings.channelId) throw new UserError("Set an archive channel first with `/automation pins channel`.");
  if (settings.channelId === channel.id) throw new UserError("This is the archive channel itself.");
  const target = await channel.guild.channels.fetch(settings.channelId).catch(() => null);
  if (!target?.isTextBased()) throw new UserError("The archive channel no longer exists. Set a new one with `/automation pins channel`.");
  guard.assertBotPermissions(target, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  guard.assertBotPermissions(channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);

  if (running.has(channel.id)) throw new UserError("This channel is already being archived.");
  running.add(channel.id);
  const result = { archived: 0, skipped: 0, unpinned: 0 };
  try {
    for (const message of await fetchAllPins(channel)) {
      if (store.pins.isArchived(channel.guildId, message.id)) result.skipped++;
      else {
        await target.send({ embeds: [archiveEmbed(message)], allowedMentions: { parse: [] } });
        store.pins.markArchived(channel.guildId, message.id);
        result.archived++;
      }
      if (settings.unpin && (await message.unpin("Pin archived").then(() => true, () => false))) result.unpinned++;
    }
  } finally {
    running.delete(channel.id);
  }
  return result;
}

/** channelPinsUpdate listener: archive once the channel is near its cap. */
async function onPinsUpdate(channel) {
  if (!channel?.guild || !channel.isTextBased()) return;
  const settings = store.pins.get(channel.guildId); // config is cached
  if (!settings.enabled || !settings.channelId || channel.id === settings.channelId || running.has(channel.id)) return;
  const first = await channel.messages.fetchPins({ limit: 50 }).catch(() => null);
  if (!first || (first.items.length < AUTO_ARCHIVE_AT && !first.hasMore)) return;
  await archive(channel, settings).catch((err) => {
    if (!(err instanceof UserError)) throw err;
    console.warn(`[automation] auto pin archive in #${channel.name}: ${err.message}`);
  });
}

module.exports = { archive, archiveEmbed, onPinsUpdate, fetchAllPins, AUTO_ARCHIVE_AT };
