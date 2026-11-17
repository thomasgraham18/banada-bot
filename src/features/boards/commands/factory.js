/**
 * Builds a whole board command (/starboard or /clownboard) from one template.
 * Both commands have the same 15 subcommands; only the wording differs.
 *
 *   module.exports = makeBoardCommand("starboard");
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, guard, parse, ui, ensure } = require("../../../core");
const store = require("../db");
const engine = require("../engine");

const GATE = "Manage Guild"; // every board subcommand (package file)

/** Board channels: anywhere the bot can post a normal message. */
const BOARD_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
/** Ignorable channels: also categories (ignores everything inside), forums and voice text chats. */
const IGNORE_CHANNEL_TYPES = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia,
  ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory,
  ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread,
];

const onOff = (v) => (v ? "**on**" : "**off**");

function buildData(meta) {
  const { name, noun } = meta;
  const bool = (sub, description) =>
    sub.setDescription(description).addBooleanOption((o) => o.setName("setting").setDescription("On or off").setRequired(true));

  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(`Highlight messages that get enough ${noun} reactions`)
    .addSubcommandGroup((g) =>
      g.setName("ignore").setDescription(`Channels, members or roles the ${name} ignores`)
        .addSubcommand((s) => s.setName("toggle").setDescription(`Ignore a channel, members or roles for new ${noun}s`)
          .addChannelOption((o) => o.setName("channel").setDescription("Channel or category to (un)ignore").addChannelTypes(...IGNORE_CHANNEL_TYPES))
          .addMentionableOption((o) => o.setName("member_or_role").setDescription("Member or role to (un)ignore")))
        .addSubcommand((s) => s.setName("list").setDescription(`View what the ${name} is ignoring`)))
    .addSubcommand((s) => s.setName("emoji").setDescription(`Set the emoji that triggers the ${name}`)
      .addStringOption((o) => o.setName("emoji").setDescription("A unicode or custom emoji").setRequired(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName("color").setDescription(`Set default color for ${name} posts`)
      .addStringOption((o) => o.setName("color").setDescription("Hex code like #ffac33 or a colour name").setRequired(true).setMaxLength(32)))
    .addSubcommand((s) => s.setName("set").setDescription(`Set the ${name} channel`)
      .addChannelOption((o) => o.setName("channel").setDescription("Defaults to this channel").addChannelTypes(...BOARD_CHANNEL_TYPES)))
    .addSubcommand((s) => bool(s.setName("selfstar"), `Allow an author to ${noun} their own message`))
    .addSubcommand((s) => bool(s.setName("attachments"), `Allow attachments to appear on ${name} posts`))
    .addSubcommand((s) => bool(s.setName("jumpurl"), `Allow the jump URL to appear on ${name} posts`))
    .addSubcommand((s) => bool(s.setName("timestamp"), `Allow a timestamp to appear on ${name} posts`))
    .addSubcommand((s) => s.setName("threshold").setDescription(`Set the amount of ${noun}s needed to post`)
      .addIntegerOption((o) => o.setName("threshold").setDescription(`Reactions needed (default ${engine.DEFAULTS.threshold})`).setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand((s) => s.setName("config").setDescription(`View this server's ${name} settings`))
    .addSubcommand((s) => s.setName("lock").setDescription(`Disable the ${name}`))
    .addSubcommand((s) => s.setName("unlock").setDescription(`Enable the ${name}`))
    .addSubcommand((s) => s.setName("reset").setDescription(`Reset the server's ${name} configuration`))
    .addSubcommand((s) => s.setName("clear").setDescription(`Reset a ${name} setting to its default`)
      .addStringOption((o) => o.setName("setting").setDescription("The setting to reset").setRequired(true)
        .addChoices(...engine.CLEARABLE.map((c) => ({ name: c, value: c })))));
}

function makeBoardCommand(kind) {
  const meta = engine.KINDS[kind];
  const { name, title } = meta;
  const current = (guildId) => store.settings.get(guildId)[kind];

  /** Every handler shares the gate; `defer` defaults to a public reply. */
  const h = (run, extra = {}) => ({ gate: GATE, run, ...extra });

  const toggle = (column, label) =>
    h(async (interaction, ctx) => {
      const value = ctx.options.getBoolean("setting", true);
      store.setBoard(ctx.guild.id, kind, { [column]: value });
      await ctx.success(`${label} on ${name} posts is now ${onOff(value)}.`);
    });

  const handlers = {
    "ignore toggle": h(async (interaction, ctx) => {
      const channel = ctx.options.getChannel("channel");
      const mentionable = ctx.options.get("member_or_role");
      ensure(channel || mentionable, "Give a `channel` and/or a `member_or_role` to (un)ignore.");
      const lines = [];
      if (channel) {
        const now = store.toggleIgnore(ctx.guild.id, kind, channel.id, "channel");
        lines.push(`${now ? "Ignoring" : "No longer ignoring"} ${channel}${channel.type === ChannelType.GuildCategory ? " (and its channels)" : ""}.`);
      }
      if (mentionable) {
        const isRole = Boolean(mentionable.role);
        const id = isRole ? mentionable.role.id : mentionable.user.id;
        ensure(!isRole || id !== ctx.guild.id, "You can't ignore @everyone; lock the board instead.");
        const now = store.toggleIgnore(ctx.guild.id, kind, id, isRole ? "role" : "member");
        lines.push(`${now ? "Ignoring" : "No longer ignoring"} ${isRole ? `<@&${id}>` : `<@${id}>`}.`);
      }
      await ctx.success(`${lines.join("\n")}\nIgnores only stop **new** ${name} posts.`);
    }),

    "ignore list": h(async (interaction, ctx) => {
      const mention = { channel: (id) => `<#${id}>`, member: (id) => `<@${id}>`, role: (id) => `<@&${id}>` };
      const lines = store.listIgnores(ctx.guild.id, kind).map((r) => `${mention[r.target_kind](r.target_id)} · ${r.target_kind}`);
      await ui.paginate(interaction, ui.listPages(ctx.client, `${title} ignores`, lines, { empty: `The ${name} isn't ignoring anything.` }));
    }),

    emoji: h(async (interaction, ctx) => {
      // With the client: rejects custom emojis the bot can't see (it couldn't match them reliably anyway).
      const emoji = parse.emoji(ctx.options.getString("emoji", true), ctx.client);
      store.setBoard(ctx.guild.id, kind, { emoji: emoji.text });
      await ctx.success(`The ${name} emoji is now ${emoji.text}.`);
    }),

    color: h(async (interaction, ctx) => {
      const colour = parse.colour(ctx.options.getString("color", true));
      store.setBoard(ctx.guild.id, kind, { color: colour });
      await ctx.success(`${title} posts will use **${parse.hex(colour)}**.`);
    }),

    set: h(async (interaction, ctx) => {
      const channel = ctx.options.getChannel("channel") ?? ctx.channel;
      ensure(channel && BOARD_CHANNEL_TYPES.includes(channel.type), "The board must be a text or announcement channel.");
      guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
      store.setBoard(ctx.guild.id, kind, { channel_id: channel.id });
      const s = current(ctx.guild.id);
      await ctx.success(
        `${title} channel set to ${channel}. Messages with **${s.threshold}** ${s.emoji} go there.` +
          (s.locked ? `\nThe ${name} is **locked**; use \`/${name} unlock\` to enable it.` : "")
      );
    }),

    selfstar: toggle("selfstar", `Counting the author's own ${meta.noun}`),
    attachments: toggle("attachments", "Showing attachments"),
    jumpurl: toggle("jumpurl", "The jump button"),
    timestamp: toggle("timestamp", "The timestamp"),

    threshold: h(async (interaction, ctx) => {
      const threshold = ctx.options.getInteger("threshold", true);
      store.setBoard(ctx.guild.id, kind, { threshold });
      await ctx.success(`Messages now need **${threshold}** ${current(ctx.guild.id).emoji} to reach the ${name}.`);
    }),

    config: h(async (interaction, ctx) => {
      const s = current(ctx.guild.id);
      const ignored = s.ignores.channel.size + s.ignores.member.size + s.ignores.role.size;
      const lines = [
        `**Status:** ${!s.channelId ? "not set up" : s.locked ? "🔒 locked" : "enabled"}`,
        `**Channel:** ${s.channelId ? `<#${s.channelId}>` : "none"}`,
        `**Emoji:** ${s.emoji}`,
        `**Threshold:** ${s.threshold}`,
        `**Color:** ${parse.hex(s.color)}`,
        `**Self-${meta.noun}:** ${onOff(s.selfstar)}`,
        `**Attachments:** ${onOff(s.attachments)}`,
        `**Jump URL:** ${onOff(s.jumpurl)}`,
        `**Timestamp:** ${onOff(s.timestamp)}`,
        `**Ignored:** ${ignored} (\`/${name} ignore list\`)`,
        `**Posts:** ${store.countPosts(ctx.guild.id, kind)}`,
      ];
      await ctx.info(lines.join("\n"), `${title} settings`);
    }),

    lock: h(async (interaction, ctx) => {
      ensure(!current(ctx.guild.id).locked, `The ${name} is already locked.`);
      store.setBoard(ctx.guild.id, kind, { locked: true });
      await ctx.success(`The ${name} is locked. Settings are kept; \`/${name} unlock\` turns it back on.`);
    }),

    unlock: h(async (interaction, ctx) => {
      const s = current(ctx.guild.id);
      ensure(s.locked, `The ${name} isn't locked.`);
      store.setBoard(ctx.guild.id, kind, { locked: false });
      await ctx.success(`The ${name} is unlocked.${s.channelId ? "" : ` Set a channel with \`/${name} set\` to start posting.`}`);
    }),

    reset: h(async (interaction, ctx) => {
      ensure(current(ctx.guild.id).configured || store.listIgnores(ctx.guild.id, kind).length, `The ${name} isn't configured.`);
      const ok = await ui.confirm(interaction, `Reset every ${name} setting and the ignore list? Posts already on the board stay.`);
      if (!ok) return;
      store.resetBoard(ctx.guild.id, kind);
      await ctx.success(`The ${name} configuration was reset.`);
    }),

    clear: h(async (interaction, ctx) => {
      const setting = ctx.options.getString("setting", true);
      ensure(engine.CLEARABLE.includes(setting), "Unknown setting.");
      store.clearSetting(ctx.guild.id, kind, setting);
      const s = current(ctx.guild.id);
      const shown = {
        emoji: s.emoji, color: parse.hex(s.color), channel: "none (the board is off until you `set` one)",
        threshold: s.threshold, selfstar: onOff(s.selfstar), attachments: onOff(s.attachments),
        jumpurl: onOff(s.jumpurl), timestamp: onOff(s.timestamp),
      }[setting];
      await ctx.success(`Reset **${setting}** to its default: ${shown}.`);
    }),
  };

  return defineCommand({ data: buildData(meta), module: name, handlers });
}

module.exports = { makeBoardCommand, buildData };
