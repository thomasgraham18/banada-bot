/**
 * /settings: the server's moderation + misc configuration (WP1).
 *
 * Every value is a guild_config key from core.config.KEYS, so the punishment
 * service, guard and other packages read them without knowing about this file.
 * Staff roles live in the core's staff_roles table (powers the "Staff Only" gate).
 */
const {
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits: P,
} = require("discord.js");
const { defineCommand, config, guard, ui, script, embeds, guildCache, ensure } = require("../../../core");
const store = require("../db");
const { CLEARABLE, MODERATION_KEYS, MUTE_OVERWRITES, configLines, overwritableChannels, BOT_OVERWRITE_PERMS } = require("../settings");

const { KEYS } = config;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

// ---------------------------------------------------------------- builder helpers

const roleSub = (name, description) => (s) =>
  s.setName(name).setDescription(description).addRoleOption((o) => o.setName("role").setDescription("The role").setRequired(true));
const channelSub = (name, description) => (s) =>
  s.setName(name).setDescription(description).addChannelOption((o) =>
    o.setName("channel").setDescription("The channel").setRequired(true).addChannelTypes(...TEXT_CHANNELS));
const boolSub = (name, description, option = "setting") => (s) =>
  s.setName(name).setDescription(description).addBooleanOption((o) => o.setName(option).setDescription("On or off").setRequired(true));

const data = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("Configure moderation roles, channels and other server settings")
  .addSubcommandGroup((g) =>
    g.setName("staff").setDescription("Staff roles (pass the Staff Only permission)")
      .addSubcommand((s) => s.setName("set").setDescription("Add or remove a staff role")
        .addRoleOption((o) => o.setName("role").setDescription("The role").setRequired(true))
        .addBooleanOption((o) => o.setName("setting").setDescription("True = staff, false = not staff").setRequired(true)))
      .addSubcommand((s) => s.setName("list").setDescription("View every staff role")))
  .addSubcommand(roleSub("muted", "Set the text muted role"))
  .addSubcommand(roleSub("imuted", "Set the image muted role"))
  .addSubcommand(roleSub("rmuted", "Set the reaction muted role"))
  .addSubcommand(roleSub("jailrole", "Set the default role for the jail system"))
  .addSubcommand(roleSub("premiumrole", "Set the Premium Members role for Server Subscriptions"))
  .addSubcommand(roleSub("baserole", "Set the base role that booster roles are placed under"))
  .addSubcommand(roleSub("dj", "Set the DJ role for the music player"))
  .addSubcommand(channelSub("modlog", "Set the mod log channel for punishments"))
  .addSubcommand(channelSub("jail", "Set the jail channel"))
  .addSubcommand((s) => s.setName("jailmsg").setDescription("Set a custom jail message")
    .addStringOption((o) => o.setName("message").setDescription("Plain text or a JSON message script ({user.mention} etc. work)").setRequired(true).setMaxLength(4000)))
  .addSubcommand((s) => s.setName("autonick").setDescription("Set a nickname given to members when they join")
    .addStringOption((o) => o.setName("nick").setDescription("Nickname ({user.name} works)").setRequired(true).setMaxLength(64)))
  .addSubcommand(channelSub("joinlogs", "Set a channel to log members joining and leaving"))
  .addSubcommand((s) => s.setName("clear").setDescription("Remove a role, channel or message setting")
    .addStringOption((o) => o.setName("setting").setDescription("Which setting").setRequired(true)
      .addChoices(...Object.keys(CLEARABLE).map((k) => ({ name: k, value: k })))))
  .addSubcommand(boolSub("autoplay", "Enable or disable autoplay for music"))
  .addSubcommand(boolSub("disablecustomfms", "Disable custom Now Playing commands", "disabled"))
  .addSubcommand(boolSub("jailroles", "Enable or disable removal of roles for jail"))
  .addSubcommand(boolSub("googlesafetylevel", "Enable or disable safe mode for Google commands"))
  .addSubcommand((s) => s.setName("reset").setDescription("Reset the moderation configuration"))
  .addSubcommand((s) => s.setName("resetcases").setDescription("Reset every jail-log case"))
  .addSubcommand((s) => s.setName("config").setDescription("View this server's settings"));

// ---------------------------------------------------------------- overwrite offers

/**
 * Shows `text` with an "apply" button. If the invoker clicks it within a
 * minute, runs apply(channel) on every channel and reports the result.
 * Short-lived, so a collector is fine (nothing to survive a restart).
 */
async function offerOverwrites(interaction, ctx, text, label, apply) {
  const me = ctx.guild.members.me;
  if (!BOT_OVERWRITE_PERMS.every((p) => me.permissions.has(p)))
    return ctx.success(`${text}\n⚠️ I need **Manage Channels** and **Manage Roles** to update channel permissions for you.`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("adm:apply").setLabel(label).setStyle(ButtonStyle.Primary)
  );
  const message = await ctx.reply({ embeds: [embeds.success(ctx.client, text)], components: [row] });
  const click = await message
    .awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (b) => {
        if (b.user.id === interaction.user.id) return true;
        b.reply({ content: "This button isn't for you.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return false;
      },
    })
    .catch(() => null);
  if (!click) return interaction.editReply({ components: [] }).catch(() => {});

  await click.update({ embeds: [embeds.info(ctx.client, "Updating channel permissions… this can take a while on big servers.")], components: [] });
  guard.assertBotPermissions(ctx.guild, BOT_OVERWRITE_PERMS);
  let ok = 0;
  const failed = [];
  for (const channel of overwritableChannels(ctx.guild)) {
    try {
      if (await apply(channel)) ok++;
    } catch {
      failed.push(`<#${channel.id}>`);
    }
  }
  const summary = `${text}\n\nUpdated **${ok}** channel(s).${failed.length ? `\nCouldn't update: ${failed.slice(0, 20).join(", ")}${failed.length > 20 ? "…" : ""}` : ""}`;
  return interaction.editReply({ embeds: [embeds.success(ctx.client, summary)], components: [] });
}

/** /settings muted|imuted|rmuted */
const muteRole = (kind, key) => ({
  gate: kind === "rmuted" ? "Manage Guild" : "Manage Guild & Roles",
  async run(interaction, ctx) {
    const role = ctx.options.getRole("role", true);
    guard.assertManageableRole(ctx.member, role); // the punishment service will assign it
    config.set(ctx.guild.id, key, role.id);
    const deny = MUTE_OVERWRITES[kind];
    await offerOverwrites(
      interaction, ctx,
      `The **${kind}** role is now ${role}.\nApply its restrictions (${Object.keys(deny).join(", ")}) to every channel?`,
      "Apply to every channel",
      (channel) => channel.permissionOverwrites.edit(role, deny, { reason: `/settings ${kind} by ${ctx.user.tag}` }).then(() => true)
    );
  },
});

/**
 * Jail role can only see the jail channel. Offered once both are set.
 */
async function offerJailOverwrites(interaction, ctx, text) {
  const roleId = config.get(ctx.guild.id, KEYS.JAIL_ROLE);
  const channelId = config.get(ctx.guild.id, KEYS.JAIL_CHANNEL);
  const role = roleId && ctx.guild.roles.cache.get(roleId);
  if (!role || !channelId || !ctx.guild.channels.cache.has(channelId))
    return ctx.success(`${text}${!role ? "\nSet `/settings jailrole` too." : "\nSet `/settings jail` too."}`);
  return offerOverwrites(
    interaction, ctx,
    `${text}\nHide every channel from ${role} except <#${channelId}>?`,
    "Set up jail permissions",
    async (channel) => {
      const reason = `/settings jail by ${ctx.user.tag}`;
      if (channel.id === channelId)
        await channel.permissionOverwrites.edit(role, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { reason });
      else await channel.permissionOverwrites.edit(role, { ViewChannel: false }, { reason });
      return true;
    }
  );
}

/** Generic "store a role" handler for roles the bot never assigns itself. */
const plainRole = (key, label, { allowManaged = false } = {}) => ({
  gate: "Manage Guild",
  defer: "ephemeral",
  async run(interaction, ctx) {
    const role = ctx.options.getRole("role", true);
    ensure(role.id !== ctx.guild.id, "You can't use @everyone for that.");
    ensure(allowManaged || !role.managed, `${role} is managed by an integration.`);
    config.set(ctx.guild.id, key, role.id);
    return ctx.success(`The ${label} is now ${role}.`);
  },
});

const channelSetting = (key, label) => ({
  gate: "Manage Guild",
  defer: "ephemeral",
  async run(interaction, ctx) {
    const channel = ctx.options.getChannel("channel", true);
    guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
    config.set(ctx.guild.id, key, channel.id);
    return ctx.success(`The ${label} is now ${channel}.`);
  },
});

const boolSetting = (key, label, option = "setting") => ({
  gate: "Manage Guild",
  defer: "ephemeral",
  async run(interaction, ctx) {
    const value = ctx.options.getBoolean(option, true);
    config.set(ctx.guild.id, key, value);
    return ctx.success(`${label} is now **${value ? "on" : "off"}**.`);
  },
});

// ---------------------------------------------------------------- command

module.exports = defineCommand({
  data,
  handlers: {
    "staff set": {
      gate: "Manage Guild",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const role = ctx.options.getRole("role", true);
        const enabled = ctx.options.getBoolean("setting", true);
        ensure(role.id !== ctx.guild.id, "You can't make @everyone a staff role.");
        const changed = store.staff.set(ctx.guild.id, role.id, enabled);
        if (!changed) return ctx.info(`${role} ${enabled ? "is already" : "isn't"} a staff role.`);
        return ctx.success(`${role} is ${enabled ? "now" : "no longer"} a staff role.`);
      },
    },
    "staff list": {
      gate: "Manage Guild",
      async run(interaction, ctx) {
        const lines = store.staff.list(ctx.guild.id).map((id) => `<@&${id}>${ctx.guild.roles.cache.has(id) ? "" : " *(deleted)*"}`);
        return ui.paginate(interaction, ui.listPages(ctx.client, "Staff roles", lines, { empty: "No staff roles. Add one with `/settings staff set`." }));
      },
    },

    muted: muteRole("muted", KEYS.MUTED_ROLE),
    imuted: muteRole("imuted", KEYS.IMUTED_ROLE),
    rmuted: muteRole("rmuted", KEYS.RMUTED_ROLE),
    jailrole: {
      gate: "Manage Guild",
      async run(interaction, ctx) {
        const role = ctx.options.getRole("role", true);
        guard.assertManageableRole(ctx.member, role);
        config.set(ctx.guild.id, KEYS.JAIL_ROLE, role.id);
        return offerJailOverwrites(interaction, ctx, `The jail role is now ${role}.`);
      },
    },
    premiumrole: plainRole(KEYS.PREMIUM_ROLE, "Premium Members role", { allowManaged: true }),
    baserole: plainRole(KEYS.BASE_ROLE, "base role for booster roles"),
    dj: plainRole(KEYS.DJ_ROLE, "DJ role"),

    modlog: channelSetting(KEYS.MODLOG_CHANNEL, "mod log channel"),
    joinlogs: channelSetting(KEYS.JOINLOG_CHANNEL, "join log channel"),
    jail: {
      gate: "Manage Guild",
      async run(interaction, ctx) {
        const channel = ctx.options.getChannel("channel", true);
        guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages]);
        config.set(ctx.guild.id, KEYS.JAIL_CHANNEL, channel.id);
        return offerJailOverwrites(interaction, ctx, `The jail channel is now ${channel}.`);
      },
    },
    jailmsg: {
      gate: "Manage Guild",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const stored = script.validate(ctx.options.getString("message", true));
        config.set(ctx.guild.id, KEYS.JAIL_MESSAGE, stored);
        const preview = script.render(stored, script.previewContext(interaction));
        return ctx.reply({ ...preview, content: `✅ Jail message saved. Preview:\n${preview.content ?? ""}`.slice(0, 2000) });
      },
    },
    autonick: {
      gate: "Manage Guild",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const nick = ctx.options.getString("nick", true).trim();
        ensure(nick.length > 0, "The nickname can't be empty.");
        config.set(ctx.guild.id, KEYS.AUTONICK, nick);
        const warning = ctx.guild.members.me.permissions.has(P.ManageNicknames) ? "" : "\n⚠️ I need **Manage Nicknames** to apply it.";
        return ctx.success(`New members will be nicknamed \`${nick}\` (cut to 32 characters).${warning}`);
      },
    },

    clear: {
      gate: "Manage Guild & Roles",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const setting = ctx.options.getString("setting", true);
        const key = CLEARABLE[setting];
        ensure(config.get(ctx.guild.id, key) !== undefined, `**${setting}** isn't set.`);
        config.remove(ctx.guild.id, key);
        return ctx.success(`Cleared **${setting}**.`);
      },
    },

    autoplay: boolSetting(KEYS.MUSIC_AUTOPLAY, "Music autoplay"),
    disablecustomfms: { ...boolSetting(KEYS.DISABLE_CUSTOM_FMS, "Disabling custom Now Playing commands", "disabled"), gate: "Manage Channels" },
    jailroles: boolSetting(KEYS.JAIL_STRIP_ROLES, "Removing (and restoring) roles on jail"),
    googlesafetylevel: boolSetting(KEYS.GOOGLE_SAFE, "Google safe search"),

    reset: {
      gate: "Administrator",
      async run(interaction, ctx) {
        if (!(await ui.confirm(interaction, "Reset the moderation configuration? This clears the muted/jail roles, jail channel + message, jail role stripping, the mod log channel and **every staff role**.")))
          return;
        config.remove(ctx.guild.id, ...MODERATION_KEYS);
        const staff = store.staff.clear(ctx.guild.id);
        guildCache.invalidateGuild(ctx.guild.id);
        return ctx.success(`Moderation settings reset (${staff} staff role${staff === 1 ? "" : "s"} removed).`);
      },
    },
    resetcases: {
      gate: "Administrator",
      async run(interaction, ctx) {
        const count = store.cases.count(ctx.guild.id);
        ensure(count > 0, "There are no cases to reset.");
        if (!(await ui.confirm(interaction, `Delete all **${count}** cases? Case numbers start again from #1.`))) return;
        store.cases.reset(ctx.guild.id);
        return ctx.success(`Deleted ${count} case${count === 1 ? "" : "s"}.`);
      },
    },
    config: {
      gate: "Manage Guild",
      async run(interaction, ctx) {
        const staff = store.staff.list(ctx.guild.id);
        const lines = [
          ...configLines(config.all(ctx.guild.id)),
          `**staff roles**: ${staff.length ? staff.map((id) => `<@&${id}>`).join(" ") : "*none*"}`,
          `**honeypots**: ${[...store.honeypots.get(ctx.guild.id)].map(([c, p]) => `<#${c}> (${p})`).join(" ") || "*none*"}`,
          `**invoke messages**: ${store.invoke.count(ctx.guild.id)}`,
          `**cases**: ${store.cases.count(ctx.guild.id)}`,
        ];
        return ui.paginate(interaction, ui.listPages(ctx.client, `Settings for ${ctx.guild.name}`, lines, { perPage: 15 }));
      },
    },
  },
});
