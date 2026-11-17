/**
 * /autorole: join roles, reaction roles, button roles and dropdown roles.
 *
 * Every subcommand needs Manage Guild + Manage Roles (checked at runtime by
 * the router), and every role a member could be given goes through
 * guard.assertManageableRole (hierarchy, managed, dangerous permissions).
 *
 * Messages are named by a message link or ID. Commands that change a menu
 * that must already exist (remove, required, placeholder...) look the
 * message up in our own tables, so they still work after the message was
 * deleted; commands that add something fetch the message from Discord.
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits: P,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { defineCommand, guard, parse, script, ui, embeds, ensure, UserError } = require("../../../core");
const store = require("../db");
const logic = require("../logic");
const { canEdit, redraw, redrawMessage } = require("../menus");

const GATE = "Manage Guild & Roles";

// ---------------------------------------------------------------- helpers

const link = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const jump = (guildId, channelId, messageId) => `[message](${link(guildId, channelId, messageId)}) in <#${channelId}>`;

/**
 * Finds a message that already has `kind` roles in this guild from a link or
 * ID, using our own tables. Returns { messageId, channelId }.
 */
function findOwned(ctx, text, kind) {
  const { messageId } = parse.messageLink(text);
  const guildId = ctx.guild.id;
  let channelId = null;
  if (kind === "reaction") channelId = store.reaction.forMessage(messageId).find((r) => r.guild_id === guildId)?.channel_id;
  if (kind === "button") channelId = store.button.forMessage(guildId, messageId)[0]?.channel_id;
  if (kind === "dropdown") channelId = store.dropdown.get(guildId, messageId)?.channel_id;
  const what = { reaction: "reaction roles", button: "button roles", dropdown: "a dropdown role menu" }[kind];
  ensure(channelId, `That message doesn't have ${what}. See \`/autorole ${kind === "reaction" ? "reactionrole" : `${kind}role`} list\`.`);
  if (kind === "reaction") assertNotPanelMessage(messageId, guildId);
  return { messageId, channelId };
}

/** Fetches one of our messages by ID, or null if it's gone. */
async function fetchOwned(ctx, channelId, messageId) {
  const channel = ctx.guild.channels.cache.get(channelId) ?? (await ctx.guild.channels.fetch(channelId).catch(() => null));
  return (await channel?.messages?.fetch(messageId).catch(() => null)) ?? null;
}

/** Throws if the web panel's menu builder manages this message (it would overwrite our edits). */
function assertNotPanelMessage(messageId, guildId) {
  const owner = guildId ? store.groups.managedBy(guildId, messageId) : null;
  if (owner === "panel")
    throw new UserError("That message is a menu built in the web panel (Reaction roles tab). Edit it there instead.");
}

/** Shows a paginated list. */
const showList = (interaction, ctx, title, lines, empty) =>
  ui.paginate(interaction, ui.listPages(ctx.client, title, lines, { empty }));

/** Autocomplete: our messages of one kind, as message links. */
const messageChoices = (kind) => (interaction, ctx) => {
  const g = ctx.guild.id;
  const channelName = (id) => `#${ctx.guild.channels.cache.get(id)?.name ?? "deleted-channel"}`;
  const roleName = (id) => ctx.guild.roles.cache.get(id)?.name ?? "deleted-role";
  if (kind === "reaction") {
    const byMessage = new Map();
    for (const r of store.reaction.all(g)) {
      if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, { channel: r.channel_id, items: [] });
      byMessage.get(r.message_id).items.push(`${r.emoji} ${roleName(r.role_id)}`);
    }
    return [...byMessage].map(([m, v]) => ({ name: `${channelName(v.channel)} • ${v.items.join(", ")}`, value: link(g, v.channel, m) }));
  }
  if (kind === "button") {
    const byMessage = new Map();
    for (const b of store.button.all(g)) {
      if (!byMessage.has(b.message_id)) byMessage.set(b.message_id, { channel: b.channel_id, items: [] });
      byMessage.get(b.message_id).items.push(b.label ?? roleName(b.role_id));
    }
    return [...byMessage].map(([m, v]) => ({ name: `${channelName(v.channel)} • ${v.items.join(", ")}`, value: link(g, v.channel, m) }));
  }
  return store.dropdown.all(g).map((menu) => ({
    name: `${channelName(menu.channel_id)} • ${menu.options.map((o) => o.title).join(", ")}`,
    value: link(g, menu.channel_id, menu.message_id),
  }));
};

/** Reads the message_link option while autocompleting another option; null if not valid yet. */
const typedMessageId = (interaction) => {
  try {
    return parse.messageLink(interaction.options.getString("message_link") ?? "").messageId;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- required (all three kinds)

/**
 * /autorole <kind> required: a role select. Members need ANY one of the
 * picked roles to use that message's roles; picking none = everyone.
 */
const requiredHandler = (kind) => async (interaction, ctx) => {
  const { messageId, channelId } = findOwned(ctx, ctx.options.getString("message_link", true), kind);
  const current = [...store.required.get(ctx.guild.id, kind, messageId)].filter((id) => ctx.guild.roles.cache.has(id));

  const select = new RoleSelectMenuBuilder()
    .setCustomId(`autorole-required:${interaction.id}`)
    .setPlaceholder("Roles allowed to use this menu")
    .setMinValues(0)
    .setMaxValues(25);
  if (current.length) select.setDefaultRoles(current.slice(0, 25));
  const clear = new ButtonBuilder().setCustomId(`autorole-required-clear:${interaction.id}`).setLabel("Let everyone use it").setStyle(ButtonStyle.Secondary);

  const prompt = await ctx.reply({
    embeds: [
      embeds.info(
        ctx.client,
        `Pick the roles a member needs to use the ${kind} roles on that ${jump(ctx.guild.id, channelId, messageId)}. ` +
          "Holding **any one** of them is enough.\n\n" +
          `Currently: ${current.length ? current.map((id) => `<@&${id}>`).join(", ") : "everyone"}`,
        "Required roles"
      ),
    ],
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(clear)],
  });

  const pick = await prompt
    .awaitMessageComponent({ time: 120_000, filter: (i) => i.user.id === interaction.user.id })
    .catch(() => null);
  if (!pick) return ctx.reply({ embeds: [embeds.info(ctx.client, "Timed out; nothing was changed.")], components: [] });

  const ids = pick.componentType === ComponentType.RoleSelect ? pick.values : [];
  store.required.set(ctx.guild.id, kind, messageId, ids);
  await pick.update({
    embeds: [
      embeds.success(
        ctx.client,
        ids.length
          ? `Members now need one of ${ids.map((id) => `<@&${id}>`).join(", ")} to use those ${kind} roles.`
          : `Everyone can use those ${kind} roles now.`
      ),
    ],
    components: [],
  });
};

// ---------------------------------------------------------------- join roles

async function joinAdd(interaction, ctx) {
  const role = ctx.options.getRole("role", true);
  guard.assertManageableRole(ctx.member, role);
  ensure(store.join.list(ctx.guild.id).length < 25, "You can have at most 25 autoroles.");
  ensure(store.join.add(ctx.guild.id, role.id), `${role} is already an autorole.`);
  await ctx.success(`New members will get ${role}. (Bots are skipped; servers with membership screening assign it once the rules are accepted.)`);
}

async function joinRemove(interaction, ctx) {
  const role = ctx.options.getRole("role", true);
  ensure(store.join.remove(ctx.guild.id, role.id), `${role} isn't an autorole.`);
  await ctx.success(`New members will no longer get ${role}.`);
}

async function joinReset(interaction, ctx) {
  ensure(store.join.list(ctx.guild.id).length, "There are no autoroles to clear.");
  if (!(await ui.confirm(interaction, "Remove **every** autorole?"))) return;
  const n = store.join.reset(ctx.guild.id);
  await ctx.success(`Removed ${n} autorole${n === 1 ? "" : "s"}.`);
}

const joinList = (interaction, ctx) =>
  showList(interaction, ctx, "Autoroles", store.join.list(ctx.guild.id).map((id, i) => `\`${i + 1}\` <@&${id}>`), "No autoroles yet. Add one with `/autorole add`.");

// ---------------------------------------------------------------- reaction roles

async function reactionAdd(interaction, ctx) {
  const message = await parse.fetchMessage(interaction, ctx.options.getString("message_link", true));
  const emoji = parse.emoji(ctx.options.getString("reaction", true), ctx.client);
  const role = ctx.options.getRole("role", true);
  guard.assertManageableRole(ctx.member, role);
  assertNotPanelMessage(message.id, ctx.guild.id);
  guard.assertBotPermissions(message.channel, [P.ViewChannel, P.ReadMessageHistory, P.AddReactions]);

  const key = parse.emojiKey(emoji);
  const onMessage = message.reactions.cache.some((r) => parse.emojiKey(r.emoji) === key);
  ensure(onMessage || message.reactions.cache.size < logic.MAX_REACTIONS, "That message already has 20 different reactions (Discord's limit).");

  try {
    await message.react(emoji.identifier);
  } catch (err) {
    if (err.code === 50013 || err.code === 50001) throw err; // translated by the router
    throw new UserError(`I couldn't react with ${emoji.text} (${err.message}).`);
  }
  store.reaction.set({ guild_id: ctx.guild.id, channel_id: message.channelId, message_id: message.id, emoji_key: key, emoji: emoji.text, role_id: role.id });
  await ctx.success(`Reacting with ${emoji.text} on that ${jump(ctx.guild.id, message.channelId, message.id)} now gives ${role}.`);
}

/** Removes the bot's own reaction for `key` from a message (best effort). */
async function unreact(ctx, channelId, messageId, keys) {
  const message = await fetchOwned(ctx, channelId, messageId);
  if (!message) return;
  for (const reaction of message.reactions.cache.values())
    if (keys.includes(parse.emojiKey(reaction.emoji))) await reaction.users.remove(ctx.client.user.id).catch(() => {});
}

async function reactionRemove(interaction, ctx) {
  const { messageId, channelId } = findOwned(ctx, ctx.options.getString("message_link", true), "reaction");
  const emoji = parse.emoji(ctx.options.getString("reaction", true)); // no client: the emoji may be from a server I left
  const key = parse.emojiKey(emoji);
  ensure(store.reaction.remove(ctx.guild.id, messageId, key), `${emoji.text} isn't a reaction role on that message.`);
  await unreact(ctx, channelId, messageId, [key]);
  await ctx.success(`Removed the ${emoji.text} reaction role from that ${jump(ctx.guild.id, channelId, messageId)}.`);
}

async function reactionRemoveAll(interaction, ctx) {
  const { messageId, channelId } = findOwned(ctx, ctx.options.getString("message_link", true), "reaction");
  if (!(await ui.confirm(interaction, `Remove every reaction role from that ${jump(ctx.guild.id, channelId, messageId)}?`))) return;
  const keys = store.reaction.forMessage(messageId).map((r) => r.emoji_key);
  const n = store.reaction.removeAll(ctx.guild.id, messageId);
  await unreact(ctx, channelId, messageId, keys);
  await ctx.success(`Removed ${n} reaction role${n === 1 ? "" : "s"} from that message.`);
}

async function reactionReset(interaction, ctx) {
  ensure(store.reaction.all(ctx.guild.id).length, "There are no reaction roles to clear.");
  if (!(await ui.confirm(interaction, "Remove **every** reaction role in this server? (My reactions stay on the messages.)"))) return;
  const n = store.reaction.reset(ctx.guild.id);
  await ctx.success(`Removed ${n} reaction role${n === 1 ? "" : "s"}.`);
}

const reactionList = (interaction, ctx) =>
  showList(
    interaction,
    ctx,
    "Reaction roles",
    store.reaction.all(ctx.guild.id).map((r) => `${r.emoji} → <@&${r.role_id}> • [message](${link(r.guild_id, r.channel_id, r.message_id)})`),
    "No reaction roles yet. Add one with `/autorole reactionrole add`."
  );

async function reactionRestore(interaction, ctx) {
  const setting = ctx.options.getBoolean("setting") ?? !store.reaction.restoreEnabled(ctx.guild.id);
  store.reaction.setRestore(ctx.guild.id, setting);
  await ctx.success(
    setting
      ? "Members who leave and rejoin get their reaction roles back."
      : "Reaction roles are no longer restored when members rejoin."
  );
}

// ---------------------------------------------------------------- button roles

const STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };

/** Copies someone else's message as the bot (content, embeds, attachments). */
async function repost(message) {
  guard.assertBotPermissions(message.channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles]);
  const payload = {
    content: message.content || undefined,
    embeds: message.embeds.filter((e) => !e.data.type || e.data.type === "rich").map((e) => e.toJSON()),
    files: message.attachments.map((a) => ({ attachment: a.url, name: a.name })),
    allowedMentions: { parse: [] },
  };
  ensure(payload.content || payload.embeds.length || payload.files.length, "That message has nothing I can copy.");
  return message.channel.send(payload);
}

async function buttonAdd(interaction, ctx) {
  let message = await parse.fetchMessage(interaction, ctx.options.getString("message_link", true));
  const role = ctx.options.getRole("role", true);
  guard.assertManageableRole(ctx.member, role);
  const emojiText = ctx.options.getString("emoji");
  const emoji = emojiText ? parse.emoji(emojiText, ctx.client).text : null;
  const label = ctx.options.getString("label") ?? role.name;
  const style = STYLES[ctx.options.getString("style") ?? "primary"];

  ensure(!message.flags.has(MessageFlags.IsComponentsV2), "I can't add buttons to that kind of message (Components V2 layout).");
  if (!canEdit(message)) {
    // Only the author can edit a message, so buttons need a bot-authored copy.
    const ok = await ui.confirm(
      interaction,
      `That ${jump(ctx.guild.id, message.channelId, message.id)} was posted by ${message.author}, and buttons can only go on my own messages.\n` +
        "**Repost it as me** and add the button there? (The original stays; delete it yourself if you like.)",
      { yes: "Repost", danger: false }
    );
    if (!ok) return;
    message = await repost(message);
  }

  const existing = store.button.forMessage(ctx.guild.id, message.id);
  ensure(existing.length < logic.MAX_BUTTONS, "That message already has 25 button roles.");
  ensure(!existing.some((b) => b.role_id === role.id), `${role} already has a button on that message.`);
  const buttons = logic.insertAt(
    existing,
    { channel_id: message.channelId, role_id: role.id, label: label.slice(0, 80), emoji, style },
    ctx.options.getInteger("index") ?? undefined
  );

  // Edit first (checks the layout fits), then save.
  await message.edit({
    components: logic.buildRows({
      menu: store.dropdown.get(ctx.guild.id, message.id),
      buttons,
      foreign: message.components.filter((row) => !logic.isOurRow(row)),
    }),
  });
  store.button.replace(ctx.guild.id, message.id, buttons);
  const at = buttons.find((b) => b.role_id === role.id).idx;
  await ctx.success(`Added a button for ${role} at position ${at} on that ${jump(ctx.guild.id, message.channelId, message.id)}.`);
}

async function buttonRemove(interaction, ctx) {
  const { messageId, channelId } = findOwned(ctx, ctx.options.getString("message_link", true), "button");
  const { removed, items } = logic.removeAt(store.button.forMessage(ctx.guild.id, messageId), ctx.options.getInteger("index", true));
  store.button.replace(ctx.guild.id, messageId, items);
  const edited = await redraw(ctx.guild, channelId, messageId);
  await ctx.success(`Removed the <@&${removed.role_id}> button.${edited ? "" : " (I couldn't update the message; it may be deleted.)"}`);
}

async function buttonRemoveAll(interaction, ctx) {
  const { messageId, channelId } = findOwned(ctx, ctx.options.getString("message_link", true), "button");
  if (!(await ui.confirm(interaction, `Remove every button role from that ${jump(ctx.guild.id, channelId, messageId)}?`))) return;
  const n = store.button.forMessage(ctx.guild.id, messageId).length;
  store.button.replace(ctx.guild.id, messageId, []);
  await redraw(ctx.guild, channelId, messageId);
  await ctx.success(`Removed ${n} button role${n === 1 ? "" : "s"}.`);
}

async function buttonReset(interaction, ctx) {
  const rows = store.button.all(ctx.guild.id);
  ensure(rows.length, "There are no button roles to clear.");
  if (!(await ui.confirm(interaction, "Remove **every** button role in this server? The buttons are taken off the messages too."))) return;
  const messages = new Map(rows.map((r) => [r.message_id, r.channel_id]));
  store.button.reset(ctx.guild.id);
  for (const [messageId, channelId] of messages) await redraw(ctx.guild, channelId, messageId);
  await ctx.success(`Removed ${rows.length} button role${rows.length === 1 ? "" : "s"} from ${messages.size} message${messages.size === 1 ? "" : "s"}.`);
}

const buttonList = (interaction, ctx) =>
  showList(
    interaction,
    ctx,
    "Button roles",
    store.button.all(ctx.guild.id).map(
      (b) => `\`${b.idx}\` ${b.emoji ? `${b.emoji} ` : ""}**${b.label ?? ""}** → <@&${b.role_id}> (${logic.STYLE_NAMES[b.style] ?? "?"}) • [message](${link(b.guild_id, b.channel_id, b.message_id)})`
    ),
    "No button roles yet. Add one with `/autorole buttonrole add`."
  );

// ---------------------------------------------------------------- dropdown roles

/** Loads a dropdown named by the message_link option. */
function ownedMenu(ctx) {
  const { messageId, channelId } = findOwned(ctx, ctx.options.getString("message_link", true), "dropdown");
  return { messageId, channelId, menu: store.dropdown.get(ctx.guild.id, messageId) };
}

const updatedNote = (edited) => (edited ? "" : " (I couldn't update the message; it may be deleted.)");

async function dropdownCreate(interaction, ctx) {
  const channel = ctx.options.getChannel("channel", true);
  const role = ctx.options.getRole("role", true);
  guard.assertManageableRole(ctx.member, role);
  guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);

  const menu = { placeholder: null, min_values: 0, max_values: null, options: [{ idx: 1, role_id: role.id, title: role.name.slice(0, 100) }] };
  const payload = script.render(logic.DEFAULT_SCRIPT, { guild: ctx.guild, channel });
  payload.components = logic.buildRows({ menu, foreign: payload.components });
  const message = await channel.send(payload);
  store.dropdown.create(ctx.guild.id, channel.id, message.id, { role_id: role.id, title: role.name.slice(0, 100) });
  await ctx.success(
    `Posted a dropdown role menu in ${channel}: [jump](${message.url}).\n` +
      "Add roles with `/autorole dropdownrole add`, and change the text with `/autorole dropdownrole message`."
  );
}

async function dropdownAdd(interaction, ctx) {
  const { messageId, channelId, menu } = ownedMenu(ctx);
  const role = ctx.options.getRole("role", true);
  guard.assertManageableRole(ctx.member, role);
  ensure(menu.options.length < logic.MAX_OPTIONS, "That dropdown already has 25 roles (Discord's limit).");
  ensure(!menu.options.some((o) => o.role_id === role.id), `${role} is already on that dropdown.`);
  const message = await fetchOwned(ctx, channelId, messageId);
  ensure(message && canEdit(message), "I can't find that dropdown's message anymore. Remove it with `/autorole dropdownrole removeall`.");

  const options = [...menu.options, { idx: menu.options.length + 1, role_id: role.id, title: role.name.slice(0, 100) }];
  await message.edit({
    components: logic.buildRows({
      menu: { ...menu, options },
      buttons: store.button.forMessage(ctx.guild.id, messageId),
      foreign: message.components.filter((row) => !logic.isOurRow(row)),
    }),
  });
  store.dropdown.replaceOptions(ctx.guild.id, messageId, options);
  await ctx.success(`Added ${role} as option ${options.length} on that ${jump(ctx.guild.id, channelId, messageId)}.`);
}

/** Opens a modal for an option's title / emoji / description (handler has defer: false). */
async function dropdownEdit(interaction, ctx) {
  const { messageId, channelId, menu } = ownedMenu(ctx);
  const index = ctx.options.getInteger("index", true);
  const option = menu.options.find((o) => o.idx === index);
  ensure(option, `Position must be between 1 and ${menu.options.length}.`);

  const input = (id, label, value, max, required) => {
    const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(required);
    if (value) field.setValue(value);
    return new ActionRowBuilder().addComponents(field);
  };
  const modalId = `autorole-edit:${interaction.id}`;
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(modalId)
      .setTitle(`Edit dropdown option ${index}`)
      .addComponents(
        input("title", "Title", option.title, 100, true),
        input("emoji", "Emoji (optional)", option.emoji, 100, false),
        input("description", "Description (optional)", option.description, 100, false)
      )
  );
  const submit = await interaction
    .awaitModalSubmit({ time: 300_000, filter: (m) => m.customId === modalId && m.user.id === interaction.user.id })
    .catch(() => null);
  if (!submit) return;
  await submit.deferReply();
  ctx.target = submit; // ctx.success / errors now go to the modal submission

  const get = (id) => submit.fields.getTextInputValue(id).trim();
  const emojiText = get("emoji");
  const updated = {
    ...option,
    title: get("title") || option.title,
    emoji: emojiText ? parse.emoji(emojiText, ctx.client).text : null,
    description: get("description") || null,
  };
  // The modal may have been open for minutes: re-read the menu and find the option by role.
  const fresh = store.dropdown.get(ctx.guild.id, messageId);
  ensure(fresh?.options.some((o) => o.role_id === option.role_id), "That option was removed while you were editing it.");
  const options = fresh.options.map((o) => (o.role_id === option.role_id ? { ...updated, idx: o.idx } : o));
  store.dropdown.replaceOptions(ctx.guild.id, messageId, options);
  const edited = await redraw(ctx.guild, channelId, messageId);
  await ctx.success(`Updated option ${index} (<@&${option.role_id}>).${updatedNote(edited)}`);
}

async function dropdownRemove(interaction, ctx) {
  const { messageId, channelId, menu } = ownedMenu(ctx);
  ensure(menu.options.length > 1, "That's the dropdown's only role. Use `/autorole dropdownrole removeall` to remove the whole menu.");
  const { removed, items } = logic.removeAt(menu.options, ctx.options.getInteger("index", true));
  store.dropdown.replaceOptions(ctx.guild.id, messageId, items);
  const edited = await redraw(ctx.guild, channelId, messageId);
  await ctx.success(`Removed <@&${removed.role_id}> from that dropdown.${updatedNote(edited)}`);
}

/**
 * Deletes a dropdown's rows and its message. If the message also carries
 * button roles (or someone else's components), only the select is removed.
 */
async function deleteMenu(ctx, messageId, channelId) {
  store.dropdown.remove(ctx.guild.id, messageId);
  const message = await fetchOwned(ctx, channelId, messageId);
  if (!message || !canEdit(message)) return;
  const othersLeft = store.button.forMessage(ctx.guild.id, messageId).length || message.components.some((row) => !logic.isOurRow(row));
  if (othersLeft) await redrawMessage(message).catch(() => {});
  else await message.delete().catch(() => {});
}

async function dropdownRemoveAll(interaction, ctx) {
  const { messageId, channelId } = ownedMenu(ctx);
  if (!(await ui.confirm(interaction, `Delete that dropdown ${jump(ctx.guild.id, channelId, messageId)} and every role on it?`))) return;
  await deleteMenu(ctx, messageId, channelId);
  await ctx.success("Removed that dropdown role menu.");
}

async function dropdownReset(interaction, ctx) {
  const menus = store.dropdown.all(ctx.guild.id);
  ensure(menus.length, "There are no dropdown role menus to clear.");
  if (!(await ui.confirm(interaction, `Delete **all ${menus.length}** dropdown role menus (and their messages)?`))) return;
  for (const menu of menus) await deleteMenu(ctx, menu.message_id, menu.channel_id);
  await ctx.success(`Removed ${menus.length} dropdown role menu${menus.length === 1 ? "" : "s"}.`);
}

const dropdownList = (interaction, ctx) =>
  showList(
    interaction,
    ctx,
    "Dropdown role menus",
    store.dropdown.all(ctx.guild.id).map((menu) => {
      const { min, max } = logic.selectBounds(menu, menu.options.length);
      const need = store.required.get(ctx.guild.id, "dropdown", menu.message_id);
      const flags = [`pick ${min}–${max}`, menu.exclusive ? "exclusive" : null, need.size ? `requires ${[...need].map((id) => `<@&${id}>`).join("/")}` : null].filter(Boolean);
      return (
        `**[Menu](${link(menu.guild_id, menu.channel_id, menu.message_id)})** in <#${menu.channel_id}> • ${flags.join(" • ")}\n` +
        menu.options.map((o) => `  \`${o.idx}\` ${o.emoji ? `${o.emoji} ` : ""}${o.title} → <@&${o.role_id}>`).join("\n")
      );
    }),
    "No dropdown role menus yet. Post one with `/autorole dropdownrole create`."
  );

async function dropdownPlaceholder(interaction, ctx) {
  const { messageId, channelId } = ownedMenu(ctx);
  const text = ctx.options.getString("text")?.trim() || null;
  store.dropdown.update(ctx.guild.id, messageId, { placeholder: text });
  const edited = await redraw(ctx.guild, channelId, messageId);
  await ctx.success(`Placeholder ${text ? `set to **${text}**` : `reset to **${logic.DEFAULT_PLACEHOLDER}**`}.${updatedNote(edited)}`);
}

async function dropdownLimit(interaction, ctx) {
  const { messageId, channelId } = ownedMenu(ctx);
  const { min, max } = logic.checkLimit(ctx.options.getInteger("minimum", true), ctx.options.getInteger("maximum", true));
  store.dropdown.update(ctx.guild.id, messageId, { min_values: min, max_values: max });
  const edited = await redraw(ctx.guild, channelId, messageId);
  await ctx.success(
    `Members pick ${min}–${max} roles at a time and can hold at most ${max} role${max === 1 ? "" : "s"} from that menu.${updatedNote(edited)}`
  );
}

async function dropdownExclusive(interaction, ctx) {
  const { messageId } = ownedMenu(ctx);
  const on = ctx.options.getBoolean("setting", true);
  store.dropdown.update(ctx.guild.id, messageId, { exclusive: on });
  await ctx.success(
    on
      ? "Exclusive: a member's pick replaces their other roles from that menu."
      : "Not exclusive: each pick toggles that role and keeps the others."
  );
}

/** Opens the script modal for the text/embed above the dropdown (defer: false). */
async function dropdownMessage(interaction, ctx) {
  const { messageId, channelId, menu } = ownedMenu(ctx);
  const result = await ctx.promptScript({ title: "Dropdown message", current: menu.script ?? logic.DEFAULT_SCRIPT });
  if (!result) return;
  const message = await fetchOwned(ctx, channelId, messageId);
  ensure(message && canEdit(message), "I can't find that dropdown's message anymore.");
  // Re-read: the menu may have changed while the modal was open.
  const menuNow = store.dropdown.get(ctx.guild.id, messageId);
  ensure(menuNow, "That dropdown was removed while you were editing it.");

  const payload = script.render(result.script, { guild: ctx.guild, channel: message.channel });
  await message.edit({
    content: payload.content ?? "",
    embeds: payload.embeds,
    allowedMentions: { parse: [] },
    // The script's link buttons replace the old ones; our menu and buttons stay.
    components: logic.buildRows({ menu: menuNow, buttons: store.button.forMessage(ctx.guild.id, messageId), foreign: payload.components }),
  });
  store.dropdown.update(ctx.guild.id, messageId, { script: result.script });
  await ctx.success(`Updated the message above that dropdown: [jump](${message.url}).`);
}

// ---------------------------------------------------------------- tree

const messageOption = (o, autocomplete = true) =>
  o.setName("message_link").setDescription("Message link or ID").setRequired(true).setAutocomplete(autocomplete);
const roleOption = (o, description) => o.setName("role").setDescription(description).setRequired(true);
const indexOption = (o, description, required = true) =>
  o.setName("index").setDescription(description).setRequired(required).setMinValue(1).setMaxValue(25);

const data = new SlashCommandBuilder()
  .setName("autorole")
  .setDescription("Join roles, reaction roles, button roles and dropdown roles")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName("add").setDescription("Add an autorole to give members on join").addRoleOption((o) => roleOption(o, "Role to give new members")))
  .addSubcommand((s) => s.setName("remove").setDescription("Remove an autorole and stop assigning it on join").addRoleOption((o) => roleOption(o, "Autorole to remove")))
  .addSubcommand((s) => s.setName("reset").setDescription("Clear every autorole in the server"))
  .addSubcommand((s) => s.setName("list").setDescription("View a list of every auto role"))
  .addSubcommandGroup((g) =>
    g
      .setName("reactionrole")
      .setDescription("Roles members get by reacting to a message")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Add a reaction role to a message")
          .addStringOption((o) => messageOption(o, false))
          .addStringOption((o) => o.setName("reaction").setDescription("Emoji to react with").setRequired(true))
          .addRoleOption((o) => roleOption(o, "Role to give"))
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove a reaction role from a message")
          .addStringOption((o) => messageOption(o))
          .addStringOption((o) => o.setName("reaction").setDescription("Emoji of the reaction role").setRequired(true).setAutocomplete(true))
      )
      .addSubcommand((s) => s.setName("removeall").setDescription("Remove all reaction roles from a message").addStringOption((o) => messageOption(o)))
      .addSubcommand((s) => s.setName("reset").setDescription("Clear every reaction role in the server"))
      .addSubcommand((s) => s.setName("list").setDescription("View a list of every reaction role"))
      .addSubcommand((s) =>
        s
          .setName("restore")
          .setDescription("Choose whether reaction roles restore when members rejoin")
          .addBooleanOption((o) => o.setName("setting").setDescription("On or off (leave empty to toggle)"))
      )
      .addSubcommand((s) =>
        s.setName("required").setDescription("Set the roles members need to use a message's reaction roles").addStringOption((o) => messageOption(o))
      )
  )
  .addSubcommandGroup((g) =>
    g
      .setName("buttonrole")
      .setDescription("Buttons that toggle a role")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Add a button role to a message")
          .addStringOption((o) => messageOption(o, false))
          .addRoleOption((o) => roleOption(o, "Role the button toggles"))
          .addIntegerOption((o) => indexOption(o, "Button position, 1-25 (5 per row). Default: last", false))
          .addStringOption((o) => o.setName("label").setDescription("Button text (default: the role name)").setMaxLength(80))
          .addStringOption((o) => o.setName("emoji").setDescription("Button emoji"))
          .addStringOption((o) =>
            o
              .setName("style")
              .setDescription("Button colour (default: blurple)")
              .addChoices(
                { name: "Blurple", value: "primary" },
                { name: "Grey", value: "secondary" },
                { name: "Green", value: "success" },
                { name: "Red", value: "danger" }
              )
          )
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove a button role from a message")
          .addStringOption((o) => messageOption(o))
          .addIntegerOption((o) => indexOption(o, "Button position").setAutocomplete(true))
      )
      .addSubcommand((s) => s.setName("removeall").setDescription("Remove all button roles from a message").addStringOption((o) => messageOption(o)))
      .addSubcommand((s) => s.setName("reset").setDescription("Clear every button role in the server"))
      .addSubcommand((s) => s.setName("list").setDescription("View a list of every button role"))
      .addSubcommand((s) =>
        s.setName("required").setDescription("Set the roles members need to use a message's button roles").addStringOption((o) => messageOption(o))
      )
  )
  .addSubcommandGroup((g) =>
    g
      .setName("dropdownrole")
      .setDescription("Select menus that give roles")
      .addSubcommand((s) =>
        s
          .setName("create")
          .setDescription("Post a dropdown role menu in a channel")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Where to post it").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
          .addRoleOption((o) => roleOption(o, "First role on the menu"))
      )
      .addSubcommand((s) =>
        s.setName("add").setDescription("Add a role to a dropdown menu").addStringOption((o) => messageOption(o)).addRoleOption((o) => roleOption(o, "Role to add"))
      )
      .addSubcommand((s) =>
        s
          .setName("edit")
          .setDescription("Change a dropdown option's title, emoji or description")
          .addStringOption((o) => messageOption(o))
          .addIntegerOption((o) => indexOption(o, "Option position").setAutocomplete(true))
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove one role from a dropdown")
          .addStringOption((o) => messageOption(o))
          .addIntegerOption((o) => indexOption(o, "Option position").setAutocomplete(true))
      )
      .addSubcommand((s) => s.setName("removeall").setDescription("Remove a dropdown and every role on it").addStringOption((o) => messageOption(o)))
      .addSubcommand((s) => s.setName("reset").setDescription("Clear every dropdown role from the server"))
      .addSubcommand((s) => s.setName("list").setDescription("View every dropdown role menu"))
      .addSubcommand((s) =>
        s
          .setName("placeholder")
          .setDescription("Set the text shown before a member picks")
          .addStringOption((o) => messageOption(o))
          .addStringOption((o) => o.setName("text").setDescription("Placeholder (leave empty to reset)").setMaxLength(150))
      )
      .addSubcommand((s) =>
        s
          .setName("limit")
          .setDescription("Set how many roles a member can hold from a dropdown")
          .addStringOption((o) => messageOption(o))
          .addIntegerOption((o) => o.setName("minimum").setDescription("Fewest roles to pick at once (0-25)").setRequired(true).setMinValue(0).setMaxValue(25))
          .addIntegerOption((o) => o.setName("maximum").setDescription("Most roles to hold from this menu (1-25)").setRequired(true).setMinValue(1).setMaxValue(25))
      )
      .addSubcommand((s) =>
        s
          .setName("exclusive")
          .setDescription("Enable or disable removing a member's other dropdown roles when they pick one")
          .addStringOption((o) => messageOption(o))
          .addBooleanOption((o) => o.setName("setting").setDescription("On or off").setRequired(true))
      )
      .addSubcommand((s) => s.setName("message").setDescription("Set the text or embed above a dropdown").addStringOption((o) => messageOption(o)))
      .addSubcommand((s) =>
        s.setName("required").setDescription("Set the roles members need to use a dropdown").addStringOption((o) => messageOption(o))
      )
  );

// Autocomplete for index options: the buttons / options on the typed message.
const buttonIndexChoices = (interaction, ctx) => {
  const id = typedMessageId(interaction);
  return id
    ? store.button.forMessage(ctx.guild.id, id).map((b) => ({ name: `${b.idx}. ${b.label ?? ""} (${ctx.guild.roles.cache.get(b.role_id)?.name ?? "deleted role"})`, value: b.idx }))
    : [];
};
const optionIndexChoices = (interaction, ctx) => {
  const id = typedMessageId(interaction);
  return id ? (store.dropdown.get(ctx.guild.id, id)?.options ?? []).map((o) => ({ name: `${o.idx}. ${o.title}`, value: o.idx })) : [];
};
const reactionEmojiChoices = (interaction, ctx) => {
  const id = typedMessageId(interaction);
  return id
    ? store.reaction
        .forMessage(id)
        .filter((r) => r.guild_id === ctx.guild.id)
        .map((r) => ({ name: `${r.emoji} → ${ctx.guild.roles.cache.get(r.role_id)?.name ?? "deleted role"}`, value: r.emoji }))
    : [];
};

/** Picks the provider for whichever option is focused. */
const autocompleteFor = (kind, others = {}) => (interaction, ctx) =>
  ctx.focused.name === "message_link" ? messageChoices(kind)(interaction, ctx) : others[ctx.focused.name]?.(interaction, ctx) ?? [];

module.exports = defineCommand({
  data,
  module: "autorole",
  gate: GATE,
  handlers: {
    add: { gate: GATE, run: joinAdd },
    remove: { gate: GATE, run: joinRemove },
    reset: { gate: GATE, run: joinReset },
    list: { gate: GATE, run: joinList },

    "reactionrole add": { gate: GATE, run: reactionAdd },
    "reactionrole remove": { gate: GATE, run: reactionRemove },
    "reactionrole removeall": { gate: GATE, run: reactionRemoveAll },
    "reactionrole reset": { gate: GATE, run: reactionReset },
    "reactionrole list": { gate: GATE, run: reactionList },
    "reactionrole restore": { gate: GATE, run: reactionRestore },
    "reactionrole required": { gate: GATE, defer: "ephemeral", run: requiredHandler("reaction") },

    "buttonrole add": { gate: GATE, run: buttonAdd },
    "buttonrole remove": { gate: GATE, run: buttonRemove },
    "buttonrole removeall": { gate: GATE, run: buttonRemoveAll },
    "buttonrole reset": { gate: GATE, run: buttonReset },
    "buttonrole list": { gate: GATE, run: buttonList },
    "buttonrole required": { gate: GATE, defer: "ephemeral", run: requiredHandler("button") },

    "dropdownrole create": { gate: GATE, run: dropdownCreate },
    "dropdownrole add": { gate: GATE, run: dropdownAdd },
    "dropdownrole edit": { gate: GATE, defer: false, run: dropdownEdit },
    "dropdownrole remove": { gate: GATE, run: dropdownRemove },
    "dropdownrole removeall": { gate: GATE, run: dropdownRemoveAll },
    "dropdownrole reset": { gate: GATE, run: dropdownReset },
    "dropdownrole list": { gate: GATE, run: dropdownList },
    "dropdownrole placeholder": { gate: GATE, run: dropdownPlaceholder },
    "dropdownrole limit": { gate: GATE, run: dropdownLimit },
    "dropdownrole exclusive": { gate: GATE, run: dropdownExclusive },
    "dropdownrole message": { gate: GATE, defer: false, run: dropdownMessage },
    "dropdownrole required": { gate: GATE, defer: "ephemeral", run: requiredHandler("dropdown") },
  },
  autocomplete: {
    "reactionrole remove": autocompleteFor("reaction", { reaction: reactionEmojiChoices }),
    "reactionrole removeall": autocompleteFor("reaction"),
    "reactionrole required": autocompleteFor("reaction"),
    "buttonrole remove": autocompleteFor("button", { index: buttonIndexChoices }),
    "buttonrole removeall": autocompleteFor("button"),
    "buttonrole required": autocompleteFor("button"),
    "dropdownrole add": autocompleteFor("dropdown"),
    "dropdownrole edit": autocompleteFor("dropdown", { index: optionIndexChoices }),
    "dropdownrole remove": autocompleteFor("dropdown", { index: optionIndexChoices }),
    "dropdownrole removeall": autocompleteFor("dropdown"),
    "dropdownrole placeholder": autocompleteFor("dropdown"),
    "dropdownrole limit": autocompleteFor("dropdown"),
    "dropdownrole exclusive": autocompleteFor("dropdown"),
    "dropdownrole message": autocompleteFor("dropdown"),
    "dropdownrole required": autocompleteFor("dropdown"),
  },
});

// Exported for tests.
module.exports.findOwned = findOwned;
