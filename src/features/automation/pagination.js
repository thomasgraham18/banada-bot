/**
 * Pagination embeds: a bot message with ◀ n/N ▶ buttons that swap between
 * stored pages. Pages are scripts (core/script.js), page 1 is the message as
 * it was when `/automation pagination set` ran.
 *
 * Buttons are persistent components ("auto:pg:<prev|next>:<current page>"),
 * so they keep working after a restart. Clicking edits the message for
 * everyone, like a shared slideshow.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const { script, embeds, parse, UserError } = require("../../core");
const store = require("./db");

const MAX_PAGES = 25;
const MAX_PER_GUILD = 100;

/** The current message (content + embeds) as a stored script. */
function messageToScript(message) {
  const data = {};
  if (message.content) data.content = message.content;
  const list = message.embeds.map((e) => e.toJSON()).filter((e) => e.type === "rich" || !e.type);
  if (list.length) data.embeds = list;
  if (!data.content && !data.embeds) throw new UserError("That message has no text or embed to use as page 1.");
  return JSON.stringify(data);
}

/** ◀ n/N ▶. The page index (0-based) rides in the custom IDs. */
function navRow(page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`auto:pg:prev:${page}`).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(total < 2),
    new ButtonBuilder().setCustomId(`auto:pg:count:${page}`).setLabel(`${page + 1}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`auto:pg:next:${page}`).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(total < 2)
  );
}

/** The edit payload showing `page` of `pages`. */
function pagePayload(pages, page, { guild, channel }) {
  const body = script.render(pages[page], { guild, channel });
  return {
    content: body.content ?? "",
    embeds: body.embeds,
    components: [...body.components, navRow(page, pages.length)].slice(0, 5),
    allowedMentions: { parse: [] },
  };
}

/**
 * Fetches the message a command points at and checks the bot can edit it.
 * Webhook messages can't be edited through the message API, so only the
 * bot's own messages qualify.
 */
async function fetchOwnMessage(interaction, link) {
  const message = await parse.fetchMessage(interaction, link);
  if (message.author.id !== interaction.client.user.id || message.webhookId)
    throw new UserError("I can only paginate messages I sent myself (I can't edit anyone else's). Send one with an embed command first.");
  return message;
}

/** The stored pagination for a message, or a UserError. */
function existing(message) {
  const row = store.paginations.get(message.id);
  if (!row) throw new UserError("That message isn't a pagination embed. Set one up with `/automation pagination set`.");
  return row;
}

/** Re-renders a pagination on `page` (clamped) and saves its pages. */
async function show(message, pages, page = 0) {
  const index = Math.min(Math.max(page, 0), pages.length - 1);
  await message.edit(pagePayload(pages, index, { guild: message.guild, channel: message.channel }));
  return index;
}

/** Validates a 1-based page option against the pages. Returns the 0-based index. */
function pageIndex(pages, page) {
  if (page < 1 || page > pages.length) throw new UserError(`That pagination has ${pages.length} page${pages.length === 1 ? "" : "s"}; pick 1-${pages.length}.`);
  return page - 1;
}

/** Button handler for "auto:pg:<action>:<page>". */
async function onButton(interaction, action, pageText) {
  const row = store.paginations.get(interaction.message.id);
  if (!row) {
    // The pagination was deleted/reset: strip the dead buttons.
    await interaction.update({ components: [] }).catch(() => {});
    return interaction.followUp({ embeds: [embeds.error(interaction.client, "This pagination no longer exists.")], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  const total = row.pages.length;
  const current = Math.min(Number(pageText) || 0, total - 1);
  const next = action === "prev" ? (current - 1 + total) % total : (current + 1) % total;
  await interaction.update(pagePayload(row.pages, next, { guild: interaction.guild, channel: interaction.channel }));
}

module.exports = { MAX_PAGES, MAX_PER_GUILD, messageToScript, navRow, pagePayload, fetchOwnMessage, existing, show, pageIndex, onButton };
