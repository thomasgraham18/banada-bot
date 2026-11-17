/**
 * Interaction helpers shared by every package.
 *
 *   await ui.respond(interaction, payload)       reply or editReply, whichever applies
 *   await ui.paginate(interaction, pages)        prev / next buttons over embeds
 *   ui.listPages(client, title, lines)           lines -> embeds that fit Discord's limits
 *   if (!(await ui.confirm(interaction, "Delete everything?"))) return;
 *   const { script, submit } = await ui.promptScript(interaction, { title, current })
 *   await ui.safeSend(channel, payload)          null instead of throwing on missing perms
 *   ui.chunk(array, 25)
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const embeds = require("./embeds");
const script = require("./script");
const { UserError } = require("./errors");

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * reply() or editReply() depending on the interaction's state. Accepts a
 * string, an EmbedBuilder or a full payload. Always resolves to the Message,
 * so collectors can be attached to it.
 */
async function respond(interaction, payload) {
  const body = typeof payload === "string" ? { content: payload } : payload?.data ? { embeds: [payload] } : payload;
  if (interaction.deferred || interaction.replied) return interaction.editReply(body);
  const response = await interaction.reply({ ...body, withResponse: true });
  return response.resource?.message ?? interaction.fetchReply();
}

/**
 * Splits lines into embeds: at most `perPage` lines and 4000 characters each.
 * Adds "Page x/y" footers.
 */
function listPages(client, title, lines, { perPage = 10, empty = "Nothing here yet.", footer } = {}) {
  if (!lines.length) return [embeds.info(client, empty, title)];
  const pages = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    const text = String(line).slice(0, 1000);
    if (current.length >= perPage || length + text.length + 1 > 4000) {
      pages.push(current);
      current = [];
      length = 0;
    }
    current.push(text);
    length += text.length + 1;
  }
  if (current.length) pages.push(current);
  return pages.map((page, i) =>
    embeds.info(client, page.join("\n"), title).setFooter({
      text: [footer, pages.length > 1 ? `Page ${i + 1}/${pages.length}` : null, `${lines.length} entr${lines.length === 1 ? "y" : "ies"}`].filter(Boolean).join(" • "),
    })
  );
}

/**
 * Shows embeds one page at a time with ◀ ▶ buttons. Only the person who ran
 * the command can turn pages; buttons are removed after `time` ms.
 */
async function paginate(interaction, pages, { time = 300_000 } = {}) {
  if (!pages.length) throw new Error("paginate() needs at least one page");
  if (pages.length === 1) return respond(interaction, { embeds: [pages[0]], components: [] });

  let page = 0;
  const row = () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("page:prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("page:count").setLabel(`${page + 1}/${pages.length}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("page:next").setEmoji("▶️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("page:close").setEmoji("✖️").setStyle(ButtonStyle.Danger)
    );

  const message = await respond(interaction, { embeds: [pages[0]], components: [row()] });
  const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time });

  collector.on("collect", async (button) => {
    if (button.user.id !== interaction.user.id)
      return button.reply({ content: "These buttons aren't for you.", flags: MessageFlags.Ephemeral });
    if (button.customId === "page:close") return collector.stop("closed");
    page = button.customId === "page:prev" ? (page - 1 + pages.length) % pages.length : (page + 1) % pages.length;
    await button.update({ embeds: [pages[page]], components: [row()] });
  });
  collector.on("end", () => interaction.editReply({ components: [] }).catch(() => {}));
  return message;
}

/**
 * Asks Yes / No with buttons. Resolves true only if the invoker clicks Yes
 * within `time` ms. Use before every reset / clear / removeall / cleanup.
 */
async function confirm(interaction, text, { time = 30_000, yes = "Confirm", danger = true } = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("confirm:yes").setLabel(yes).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("confirm:no").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  const message = await respond(interaction, { embeds: [embeds.warn(interaction.client, text)], components: [row] });

  try {
    const click = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time,
      filter: (b) => {
        if (b.user.id === interaction.user.id) return true;
        b.reply({ content: "This prompt isn't for you.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return false;
      },
    });
    const ok = click.customId === "confirm:yes";
    await click.update({ embeds: [ok ? embeds.info(interaction.client, "Working on it…") : embeds.info(interaction.client, "Cancelled.")], components: [] });
    return ok;
  } catch {
    await interaction.editReply({ embeds: [embeds.info(interaction.client, "Timed out; nothing was changed.")], components: [] }).catch(() => {});
    return false;
  }
}

/**
 * Opens a script modal (core/script.js) and waits for it.
 * The handler must use `defer: false` (a modal must be the first response).
 * Returns { script, submit } where `submit` is the deferred modal interaction
 * to reply to; resolves null if the user closes the modal (times out).
 */
async function promptScript(interaction, { title = "Edit message", current, time = 600_000 } = {}) {
  const customId = `script:${interaction.id}`;
  await interaction.showModal(script.modal(customId, title, current));
  const submit = await interaction
    .awaitModalSubmit({ time, filter: (m) => m.customId === customId && m.user.id === interaction.user.id })
    .catch(() => null);
  if (!submit) return null;
  await submit.deferReply();
  try {
    return { script: script.fromModal(submit), submit };
  } catch (err) {
    if (err instanceof UserError) {
      await submit.editReply({ embeds: [embeds.error(interaction.client, err.message)] });
      return null;
    }
    throw err;
  }
}

/**
 * Sends to a channel if the bot may; returns the message, or null (and logs
 * why) instead of throwing. For listeners where nobody is waiting for a reply.
 */
async function safeSend(channel, payload) {
  if (!channel?.isTextBased?.()) return null;
  const perms = channel.guild ? channel.permissionsFor(channel.guild.members.me) : null;
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return null;
  if (perms && payload?.embeds?.length && !perms.has(PermissionFlagsBits.EmbedLinks)) return null;
  try {
    return await channel.send(payload);
  } catch (err) {
    console.warn(`[safeSend] #${channel.name ?? channel.id}: ${err.message}`);
    return null;
  }
}

/** Placeholder for subcommands a package marks STRETCH. */
const notImplemented = () => {
  throw new UserError("This subcommand isn't implemented yet.");
};

module.exports = { chunk, respond, listPages, paginate, confirm, promptScript, safeSend, notImplemented };
