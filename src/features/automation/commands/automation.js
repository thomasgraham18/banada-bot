/**
 * /automation: pagination, pin archive, social reposter, publisher,
 * counters, timers and leaderboards (guide WP7, 42 subcommands in 7 groups).
 *
 * Groups:            subcommands
 *   pagination       8
 *   pins             6
 *   reposter         6   (settings only; media reposting is STRETCH, see below)
 *   publisher        3
 *   counter          5
 *   timer            5
 *   leaderboard      9
 */
const {
  ActionRowBuilder,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { defineCommand, guard, parse, script, ui, UserError, ensure } = require("../../../core");
const store = require("../db");
const fmt = require("../format");
const pagination = require("../pagination");
const pins = require("../pins");
const counters = require("../counters");
const timers = require("../timers");
const leaderboards = require("../leaderboards");
const activity = require("../activity");

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const COUNTER_CHANNELS = [ChannelType.GuildVoice, ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory, ChannelType.GuildStageVoice];
const MAX_COUNTERS = 20;
const MAX_TIMERS = 25;

const onOff = (v) => (v ? "**enabled**" : "**disabled**");
const choices = (obj) => Object.entries(obj).map(([value, name]) => ({ name, value }));
const messageUrl = (row) => `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`;

// ---------------------------------------------------------------- option helpers

const settingOpt = (desc) => (s) => s.addBooleanOption((o) => o.setName("setting").setDescription(desc).setRequired(true));
const linkOpt = (s) => s.addStringOption((o) => o.setName("message_link").setDescription("Link (or ID) of the message").setRequired(true));
const pageOpt = (s) => s.addIntegerOption((o) => o.setName("page").setDescription("Page number (1 = first)").setRequired(true).setMinValue(1).setMaxValue(pagination.MAX_PAGES));
const kindOpt = (s) => s.addStringOption((o) => o.setName("kind").setDescription("What the board ranks").setRequired(true).addChoices(...choices(fmt.LEADERBOARD_KINDS)));
const timeframeOpt = (s) => s.addStringOption((o) => o.setName("timeframe").setDescription("Period the board covers (resets at 00:00 UTC)").setRequired(true).addChoices(...choices(fmt.TIMEFRAMES)));
const counterOptionOpt = (s) => s.addStringOption((o) => o.setName("option").setDescription("What to count").setRequired(true).addChoices(...choices(fmt.COUNTER_OPTIONS)));
const counterStyleOpts = (s) =>
  s
    .addBooleanOption((o) => o.setName("prettify").setDescription("Shorten big numbers (1.2K instead of 1,234)"))
    .addStringOption((o) => o.setName("currency").setDescription("Symbol shown before the number, e.g. $").setMaxLength(5))
    .addStringOption((o) => o.setName("name").setDescription("Channel name, e.g. \"Members: {count}\" (or just a label)").setMaxLength(90));

// ---------------------------------------------------------------- tree

const data = new SlashCommandBuilder()
  .setName("automation")
  .setDescription("Pagination, pin archive, publisher, counters, timers and leaderboards")
  .addSubcommandGroup((g) =>
    g
      .setName("pagination")
      .setDescription("Turn bot messages into multi-page embeds")
      .addSubcommand((s) => linkOpt(s.setName("set").setDescription("Set up an existing embed to be paginated")))
      .addSubcommand((s) => linkOpt(s.setName("restorereactions").setDescription("Restore the page buttons to an existing pagination")))
      .addSubcommand((s) => linkOpt(s.setName("add").setDescription("Add a page to a pagination embed")))
      .addSubcommand((s) => linkOpt(s.setName("delete").setDescription("Delete a pagination embed entirely")))
      .addSubcommand((s) => pageOpt(linkOpt(s.setName("remove").setDescription("Remove a page from a pagination embed"))))
      .addSubcommand((s) => pageOpt(linkOpt(s.setName("update").setDescription("Update an existing page on a pagination embed"))))
      .addSubcommand((s) => s.setName("list").setDescription("View all existing pagination embeds"))
      .addSubcommand((s) => s.setName("reset").setDescription("Remove every existing pagination in the server"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("pins")
      .setDescription("Archive pinned messages into a channel")
      .addSubcommand((s) => settingOpt("Archive pins automatically")(s.setName("set").setDescription("Enable or disable the pin archival system")))
      .addSubcommand((s) => settingOpt("Unpin messages once archived")(s.setName("unpin").setDescription("Enable or disable the unpinning of messages during archival")))
      .addSubcommand((s) =>
        s.setName("channel").setDescription("Set the pin archival channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Where archived pins are posted").setRequired(true).addChannelTypes(...TEXT_CHANNELS))
      )
      .addSubcommand((s) => s.setName("config").setDescription("View the pin archival config"))
      .addSubcommand((s) => s.setName("reset").setDescription("Reset the pin archival config"))
      .addSubcommand((s) => s.setName("archive").setDescription("Archive the pins in the current channel"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("reposter")
      .setDescription("Social media reposting settings")
      .addSubcommand((s) => settingOpt("On or off")(s.setName("set").setDescription("Enable or disable social media reposting")))
      .addSubcommand((s) => settingOpt("On or off")(s.setName("embed").setDescription("Enable or disable embed attached to media")))
      .addSubcommand((s) => settingOpt("On or off")(s.setName("delete").setDescription("Enable or disable deletion of social media links")))
      .addSubcommand((s) => settingOpt("On or off")(s.setName("suppress").setDescription("Enable or disable suppression of context links")))
      .addSubcommand((s) => settingOpt("On or off")(s.setName("prefix").setDescription("Enable or disable a prefix word for reposting")))
      .addSubcommand((s) => settingOpt("On or off")(s.setName("strict").setDescription("Enable or disable matching links throughout messages")))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("publisher")
      .setDescription("Auto-publish messages in announcement channels")
      .addSubcommand((s) =>
        s.setName("add").setDescription("Add a publisher channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Announcement channel").setRequired(true).addChannelTypes(ChannelType.GuildAnnouncement))
      )
      .addSubcommand((s) =>
        s.setName("remove").setDescription("Remove a publisher channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Announcement channel").setRequired(true).addChannelTypes(ChannelType.GuildAnnouncement))
      )
      .addSubcommand((s) => s.setName("list").setDescription("List all publisher channels"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("counter")
      .setDescription("Channels whose name shows a live count")
      .addSubcommand((s) =>
        counterStyleOpts(
          counterOptionOpt(s.setName("add").setDescription("Create a channel counter")).addStringOption((o) =>
            o.setName("channel_type").setDescription("Type of channel to create").setRequired(true)
              .addChoices({ name: "Voice (locked)", value: "voice" }, { name: "Text (read-only)", value: "text" }, { name: "Category", value: "category" })
          )
        )
      )
      .addSubcommand((s) =>
        counterStyleOpts(
          counterOptionOpt(
            s.setName("set").setDescription("Set a channel counter to an existing channel")
              .addChannelOption((o) => o.setName("channel").setDescription("Channel to rename").setRequired(true).addChannelTypes(...COUNTER_CHANNELS))
          )
        )
      )
      .addSubcommand((s) =>
        s.setName("remove").setDescription("Remove a channel counter")
          .addChannelOption((o) => o.setName("channel").setDescription("Counter channel").setRequired(true).addChannelTypes(...COUNTER_CHANNELS))
          .addStringOption((o) =>
            o.setName("action").setDescription("Keep the channel or delete it (default: keep)")
              .addChoices({ name: "Keep the channel", value: "keep" }, { name: "Delete the channel", value: "delete" })
          )
      )
      .addSubcommand((s) =>
        s.setName("config").setDescription("View a counter's settings")
          .addChannelOption((o) => o.setName("channel").setDescription("Counter channel").setRequired(true).addChannelTypes(...COUNTER_CHANNELS))
      )
      .addSubcommand((s) => s.setName("list").setDescription("List every counter available in this server"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("timer")
      .setDescription("Repeating messages")
      .addSubcommand((s) =>
        s.setName("add").setDescription("Add a repeating message to a channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Where to post").setRequired(true).addChannelTypes(...TEXT_CHANNELS))
          .addStringOption((o) => o.setName("interval").setDescription("How often, e.g. 30m, 2h, 1d (min 5m, default 1h)").setMaxLength(20))
      )
      .addSubcommand((s) => settingOpt("Only post after someone has chatted")(s.setName("activity").setDescription("Enable or disable channel activity requirement")))
      .addSubcommand((s) =>
        s.setName("remove").setDescription("Remove a repeating message from a channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Timer channel").setRequired(true).addChannelTypes(...TEXT_CHANNELS))
      )
      .addSubcommand((s) =>
        s.setName("view").setDescription("Preview a channel's auto message")
          .addChannelOption((o) => o.setName("channel").setDescription("Timer channel").setRequired(true).addChannelTypes(...TEXT_CHANNELS))
      )
      .addSubcommand((s) => s.setName("list").setDescription("View all auto messages in your server"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("leaderboard")
      .setDescription("Self-updating leaderboards")
      .addSubcommand((s) =>
        timeframeOpt(kindOpt(s.setName("channel").setDescription("Set the leaderboard channel")))
          .addChannelOption((o) => o.setName("channel").setDescription("Where the board is posted").setRequired(true).addChannelTypes(...TEXT_CHANNELS))
      )
      .addSubcommand((s) => timeframeOpt(kindOpt(s.setName("message").setDescription("Customize a leaderboard's message"))))
      .addSubcommand((s) =>
        kindOpt(s.setName("emote").setDescription("Set the emote shown next to a leaderboard rank"))
          .addIntegerOption((o) => o.setName("rank").setDescription("Rank 1-10").setRequired(true).setMinValue(1).setMaxValue(fmt.LEADERBOARD_SIZE))
          .addStringOption((o) => o.setName("emote").setDescription("Emoji (leave empty to reset)"))
      )
      .addSubcommand((s) => kindOpt(s.setName("emotes").setDescription("Set every rank's emote at once")))
      .addSubcommand((s) => timeframeOpt(kindOpt(s.setName("resend").setDescription("Post a leaderboard again"))))
      .addSubcommand((s) => timeframeOpt(kindOpt(s.setName("view").setDescription("Preview a leaderboard privately"))))
      .addSubcommand((s) =>
        timeframeOpt(kindOpt(s.setName("remove").setDescription("Remove a leaderboard")))
          .addBooleanOption((o) => o.setName("delete_message").setDescription("Also delete the board's message"))
      )
      .addSubcommand((s) => s.setName("config").setDescription("View this server's leaderboards"))
      .addSubcommand((s) => s.setName("variables").setDescription("View the variables a leaderboard message can use"))
  );

// ---------------------------------------------------------------- pagination

const paginationHandlers = {
  "pagination set": {
    gate: "Manage Messages",
    async run(interaction, ctx) {
      const message = await pagination.fetchOwnMessage(interaction, ctx.options.getString("message_link"));
      ensure(!store.paginations.get(message.id), "That message is already paginated. Use `/automation pagination add` to add pages.");
      ensure(store.paginations.count(ctx.guild.id) < pagination.MAX_PER_GUILD, `This server already has ${pagination.MAX_PER_GUILD} paginations.`);
      const pages = [pagination.messageToScript(message)];
      store.paginations.create(message, pages, ctx.user.id);
      await pagination.show(message, pages, 0);
      await ctx.success(`[That message](${message.url}) is now page 1 of a pagination. Add pages with \`/automation pagination add\`.`);
    },
  },

  "pagination restorereactions": {
    gate: "Manage Messages",
    async run(interaction, ctx) {
      const message = await pagination.fetchOwnMessage(interaction, ctx.options.getString("message_link"));
      const row = pagination.existing(message);
      await pagination.show(message, row.pages, 0);
      await ctx.success(`Restored the page buttons on [that message](${message.url}).`);
    },
  },

  "pagination add": {
    gate: "Manage Messages",
    defer: false, // opens a modal
    async run(interaction, ctx) {
      const message = await pagination.fetchOwnMessage(interaction, ctx.options.getString("message_link"));
      const row = pagination.existing(message);
      ensure(row.pages.length < pagination.MAX_PAGES, `A pagination can have at most ${pagination.MAX_PAGES} pages.`);
      const result = await ctx.promptScript({ title: `Page ${row.pages.length + 1}` });
      if (!result) return;
      const pages = [...(store.paginations.get(message.id)?.pages ?? row.pages), result.script];
      store.paginations.setPages(message.id, pages);
      await pagination.show(message, pages, pages.length - 1);
      await ctx.success(`Added page ${pages.length} to [the pagination](${message.url}).`);
    },
  },

  "pagination update": {
    gate: "Manage Messages",
    defer: false,
    async run(interaction, ctx) {
      const message = await pagination.fetchOwnMessage(interaction, ctx.options.getString("message_link"));
      const row = pagination.existing(message);
      const index = pagination.pageIndex(row.pages, ctx.options.getInteger("page"));
      const result = await ctx.promptScript({ title: `Edit page ${index + 1}`, current: row.pages[index] });
      if (!result) return;
      const pages = [...(store.paginations.get(message.id)?.pages ?? row.pages)];
      ensure(index < pages.length, "That page was removed while you were editing.");
      pages[index] = result.script;
      store.paginations.setPages(message.id, pages);
      await pagination.show(message, pages, index);
      await ctx.success(`Updated page ${index + 1} of [the pagination](${message.url}).`);
    },
  },

  "pagination remove": {
    gate: "Manage Messages",
    async run(interaction, ctx) {
      const message = await pagination.fetchOwnMessage(interaction, ctx.options.getString("message_link"));
      const row = pagination.existing(message);
      const index = pagination.pageIndex(row.pages, ctx.options.getInteger("page"));
      ensure(row.pages.length > 1, "That's the only page. Use `/automation pagination delete` to remove the whole pagination.");
      const pages = row.pages.filter((_, i) => i !== index);
      store.paginations.setPages(message.id, pages);
      await pagination.show(message, pages, 0);
      await ctx.success(`Removed page ${index + 1}. [The pagination](${message.url}) now has ${pages.length} page${pages.length === 1 ? "" : "s"}.`);
    },
  },

  "pagination delete": {
    gate: "Manage Messages",
    async run(interaction, ctx) {
      const message = await pagination.fetchOwnMessage(interaction, ctx.options.getString("message_link"));
      pagination.existing(message);
      if (!(await ui.confirm(interaction, `Delete [this pagination](${message.url}) and its message?`))) return;
      store.paginations.remove(message.id);
      await message.delete().catch(() => {});
      await ctx.success("Deleted the pagination and its message.");
    },
  },

  "pagination list": {
    gate: "Manage Messages",
    async run(interaction, ctx) {
      const lines = store.paginations.list(ctx.guild.id).map(
        (r, i) => `\`${i + 1}\` [message](${messageUrl(r)}) in <#${r.channel_id}> · ${r.pages.length} page${r.pages.length === 1 ? "" : "s"}`
      );
      await ui.paginate(interaction, ui.listPages(ctx.client, "Pagination embeds", lines, { empty: "No pagination embeds yet." }));
    },
  },

  "pagination reset": {
    gate: "Administrator",
    async run(interaction, ctx) {
      const count = store.paginations.count(ctx.guild.id);
      ensure(count, "There are no paginations to remove.");
      if (!(await ui.confirm(interaction, `Remove all **${count}** pagination embeds? Their messages stay, but the buttons stop working.`))) return;
      store.paginations.removeAll(ctx.guild.id);
      await ctx.success(`Removed ${count} pagination${count === 1 ? "" : "s"}. Leftover buttons disappear when clicked.`);
    },
  },
};

// ---------------------------------------------------------------- pins

const pinHandlers = {
  "pins set": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const enabled = ctx.options.getBoolean("setting");
      store.pins.set(ctx.guild.id, { enabled });
      const { channelId } = store.pins.get(ctx.guild.id);
      const hint = enabled && !channelId ? "\nSet the archive channel with `/automation pins channel`." : "";
      await ctx.success(`Automatic pin archival is ${onOff(enabled)}. Channels are archived once they reach ${pins.AUTO_ARCHIVE_AT} pins.${hint}`);
    },
  },

  "pins unpin": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const unpin = ctx.options.getBoolean("setting");
      store.pins.set(ctx.guild.id, { unpin });
      await ctx.success(`Unpinning archived messages is ${onOff(unpin)}.`);
    },
  },

  "pins channel": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
      store.pins.set(ctx.guild.id, { channelId: channel.id });
      await ctx.success(`Archived pins will be posted in ${channel}.`);
    },
  },

  "pins config": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const s = store.pins.get(ctx.guild.id);
      await ctx.info(
        [
          `**Automatic archival:** ${onOff(s.enabled)} (at ${pins.AUTO_ARCHIVE_AT}+ pins)`,
          `**Unpin after archiving:** ${onOff(s.unpin)}`,
          `**Archive channel:** ${s.channelId ? `<#${s.channelId}>` : "not set"}`,
        ].join("\n"),
        "Pin archive"
      );
    },
  },

  "pins reset": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      if (!(await ui.confirm(interaction, "Reset the pin archive settings? Already archived pins stay where they are."))) return;
      store.pins.reset(ctx.guild.id);
      await ctx.success("The pin archive settings were reset.");
    },
  },

  "pins archive": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      ensure(ctx.channel?.messages, "Run this in a text channel.");
      const r = await pins.archive(ctx.channel);
      const parts = [`Archived **${r.archived}** pin${r.archived === 1 ? "" : "s"}`];
      if (r.skipped) parts.push(`${r.skipped} already archived`);
      if (r.unpinned) parts.push(`${r.unpinned} unpinned`);
      await ctx.success(`${parts.join(", ")}.`);
    },
  },
};

// ---------------------------------------------------------------- reposter (STRETCH)

/**
 * Reposting needs an external downloader for TikTok / Instagram / X /
 * YouTube Shorts media. None of those platforms offers a public download
 * API, and scraping them breaks their terms of service and changes weekly,
 * so this package only stores the settings. Turning the feature on says so.
 */
const REPOSTER_TOGGLES = {
  embed: "Info embed on reposted media",
  delete: "Deleting the original link message",
  suppress: "Suppressing the original link preview",
  prefix: "Requiring a prefix word to repost",
  strict: "Matching links anywhere in a message",
};

const reposterHandlers = {
  "reposter set": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const enabled = ctx.options.getBoolean("setting");
      if (enabled)
        throw new UserError(
          "Social media reposting isn't implemented yet: it needs an external media downloader, and TikTok, Instagram and X don't allow downloading through their sites. The other `/automation reposter` settings are saved for when it is."
        );
      store.reposter.set(ctx.guild.id, { enabled: false });
      await ctx.success("Social media reposting is **disabled**.");
    },
  },
};
for (const [key, label] of Object.entries(REPOSTER_TOGGLES))
  reposterHandlers[`reposter ${key}`] = {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const value = ctx.options.getBoolean("setting");
      store.reposter.set(ctx.guild.id, { [key]: value });
      await ctx.success(`${label} is ${onOff(value)}.\n-# Media reposting itself isn't implemented yet; this setting is saved for when it is.`);
    },
  };

// ---------------------------------------------------------------- publisher

const publisherHandlers = {
  "publisher add": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      ensure(channel.type === ChannelType.GuildAnnouncement, "Only announcement channels can publish messages.");
      guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.ManageMessages]);
      ensure(store.publisher.add(ctx.guild.id, channel.id), `${channel} is already a publisher channel.`);
      await ctx.success(`Messages in ${channel} will be published automatically.\n-# Discord allows 10 publishes per channel per hour; messages past that stay unpublished.`);
    },
  },

  "publisher remove": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      ensure(store.publisher.remove(ctx.guild.id, channel.id), `${channel} isn't a publisher channel.`);
      await ctx.success(`Messages in ${channel} won't be published automatically any more.`);
    },
  },

  "publisher list": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      const lines = store.publisher.list(ctx.guild.id).map((id) => `<#${id}>`);
      await ui.paginate(interaction, ui.listPages(ctx.client, "Publisher channels", lines, { empty: "No publisher channels yet." }));
    },
  },
};

// ---------------------------------------------------------------- counters

/** Reads the shared counter options into a stored row (minus channel). */
function counterSettings(ctx) {
  const option = ctx.options.getString("option");
  return {
    guild_id: ctx.guild.id,
    option,
    prettify: ctx.options.getBoolean("prettify") ?? false,
    currency: ctx.options.getString("currency")?.trim() || null,
    name_template: fmt.counterTemplate(option, ctx.options.getString("name")),
  };
}

function describeCounter(c) {
  return [
    `**Channel:** <#${c.channel_id}>`,
    `**Counts:** ${fmt.COUNTER_OPTIONS[c.option] ?? c.option}`,
    `**Name:** \`${c.name_template}\``,
    `**Prettify:** ${c.prettify ? "yes (1.2K)" : "no (1,234)"}`,
    `**Currency:** ${c.currency ?? "none"}`,
    `**Last name set:** ${c.last_name ? `\`${c.last_name}\`` : "pending"}`,
  ].join("\n");
}

const CHANNEL_TYPES = { voice: ChannelType.GuildVoice, text: ChannelType.GuildText, category: ChannelType.GuildCategory };

const counterHandlers = {
  "counter add": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      ensure(store.counters.count(ctx.guild.id) < MAX_COUNTERS, `This server already has ${MAX_COUNTERS} counters.`);
      guard.assertBotPermissions(ctx.guild, [P.ManageChannels]);
      const settings = counterSettings(ctx);
      const type = ctx.options.getString("channel_type");
      const name = await counters.render(ctx.guild, settings);

      // Lock it so it works as a display: nobody joins the voice channel or
      // writes in the text channel. The bot keeps access to rename it.
      const everyone = ctx.guild.roles.everyone.id;
      const deny = type === "voice" ? [P.Connect] : type === "text" ? [P.SendMessages] : [];
      const channel = await ctx.guild.channels.create({
        name,
        type: CHANNEL_TYPES[type],
        permissionOverwrites: deny.length ? [{ id: everyone, deny }] : [],
        reason: `Channel counter created by ${ctx.user.tag}`,
      });
      store.counters.upsert({ ...settings, channel_id: channel.id, last_name: name });
      counters.schedule(ctx.guild.id, channel.id);
      await ctx.success(`Created ${channel}. It updates every 10 minutes (Discord's rename limit).`);
    },
  },

  "counter set": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      const isNew = !store.counters.get(channel.id);
      ensure(!isNew || store.counters.count(ctx.guild.id) < MAX_COUNTERS, `This server already has ${MAX_COUNTERS} counters.`);
      guard.assertBotPermissions(channel, [P.ViewChannel, P.ManageChannels]);
      store.counters.upsert({ ...counterSettings(ctx), channel_id: channel.id, last_name: null });
      const name = await counters.update(ctx.client, channel.id);
      counters.schedule(ctx.guild.id, channel.id);
      await ctx.success(`${channel} is ${isNew ? "now" : "still"} a counter and will be renamed to \`${name}\`. It updates every 10 minutes.`);
    },
  },

  "counter remove": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      ensure(store.counters.get(channel.id), `${channel} isn't a counter.`);
      const del = ctx.options.getString("action") === "delete";
      if (del) {
        guard.assertBotPermissions(channel, [P.ManageChannels]);
        if (!(await ui.confirm(interaction, `Delete the channel **${channel.name}**?`))) return;
      }
      store.counters.remove(channel.id);
      counters.unschedule(channel.id);
      if (del) await channel.delete(`Counter removed by ${ctx.user.tag}`);
      await ctx.success(del ? `Deleted the counter channel **${channel.name}**.` : `${channel} is no longer a counter. Its name stays as it is.`);
    },
  },

  "counter config": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      const counter = ensure(store.counters.get(channel.id), `${channel} isn't a counter.`);
      await ctx.info(describeCounter(counter), "Counter");
    },
  },

  "counter list": {
    gate: "Manage Channels",
    async run(interaction, ctx) {
      const lines = store.counters.list(ctx.guild.id).map((c) => `<#${c.channel_id}> · ${fmt.COUNTER_OPTIONS[c.option] ?? c.option} · \`${c.name_template}\``);
      await ui.paginate(interaction, ui.listPages(ctx.client, "Channel counters", lines, { empty: "No counters yet. Create one with `/automation counter add`." }));
    },
  },
};

// ---------------------------------------------------------------- timers

const timerHandlers = {
  "timer add": {
    gate: "Manage Guild",
    defer: false, // opens a modal
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      const current = store.timers.get(channel.id);
      ensure(current || store.timers.count(ctx.guild.id) < MAX_TIMERS, `This server already has ${MAX_TIMERS} timers.`);
      // Validate everything before the modal so nobody types a message for nothing.
      const intervalText = ctx.options.getString("interval");
      const intervalMs = intervalText || !current ? fmt.timerInterval(intervalText) : current.interval_ms;
      guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);

      const result = await ctx.promptScript({ title: `Timer for #${channel.name}`, current: current?.script });
      if (!result) return;
      store.timers.upsert({ channelId: channel.id, guildId: ctx.guild.id, script: result.script, intervalMs, userId: ctx.user.id });
      timers.schedule(ctx.guild.id, channel.id, intervalMs);
      const when = parse.timestamp(Date.now() + intervalMs, "R");
      await ctx.success(`${current ? "Updated the" : "Added a"} timer in ${channel}: every **${parse.formatDuration(intervalMs)}**, first post ${when}.`);
    },
  },

  "timer activity": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const value = ctx.options.getBoolean("setting");
      store.timers.setActivity(ctx.guild.id, value);
      await ctx.success(
        value
          ? "Timers now only post when someone (not a bot) has chatted in the channel since their last post."
          : "Timers now post on schedule whether or not the channel is active."
      );
    },
  },

  "timer remove": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      ensure(store.timers.remove(channel.id), `${channel} has no timer.`);
      timers.unschedule(channel.id);
      await ctx.success(`Removed the timer in ${channel}.`);
    },
  },

  "timer view": {
    gate: "Manage Guild",
    defer: "ephemeral",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel");
      const timer = ensure(store.timers.get(channel.id), `${channel} has no timer.`);
      const body = script.render(timer.script, { guild: ctx.guild, channel });
      const next = timers.nextRun(ctx.guild.id, channel.id);
      const header = `-# Timer in ${channel} · every ${parse.formatDuration(timer.interval_ms)}${next ? ` · next ${parse.timestamp(next, "R")}` : ""}`;
      await ctx.reply({ ...body, content: [header, body.content === "​" ? null : body.content].filter(Boolean).join("\n").slice(0, 2000), allowedMentions: { parse: [] } });
    },
  },

  "timer list": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const activityOn = store.timers.activity(ctx.guild.id);
      const lines = store.timers.list(ctx.guild.id).map((t) => {
        const next = timers.nextRun(ctx.guild.id, t.channel_id);
        return `<#${t.channel_id}> · every ${parse.formatDuration(t.interval_ms)}${next ? ` · next ${parse.timestamp(next, "R")}` : ""}`;
      });
      await ui.paginate(
        interaction,
        ui.listPages(ctx.client, "Timers", lines, { empty: "No timers yet. Add one with `/automation timer add`.", footer: `Activity requirement: ${activityOn ? "on" : "off"}` })
      );
    },
  },
};

// ---------------------------------------------------------------- leaderboards

const kt = (ctx) => [ctx.options.getString("kind"), ctx.options.getString("timeframe")];
const boardName = (kind, timeframe) => `**${fmt.LEADERBOARD_KINDS[kind]} · ${fmt.TIMEFRAMES[timeframe]}**`;
const requireBoard = (guildId, kind, timeframe) =>
  ensure(store.boards.get(guildId, kind, timeframe), `There's no ${boardName(kind, timeframe)} leaderboard. Create it with \`/automation leaderboard channel\`.`);

/** Opens a modal with one text box; resolves { value, submit } or null. */
async function promptText(interaction, { title, label, value, placeholder }) {
  const id = `auto:modal:${interaction.id}`;
  const input = new TextInputBuilder().setCustomId("value").setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
  if (value) input.setValue(value);
  if (placeholder) input.setPlaceholder(placeholder);
  await interaction.showModal(new ModalBuilder().setCustomId(id).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input)));
  const submit = await interaction.awaitModalSubmit({ time: 600_000, filter: (m) => m.customId === id && m.user.id === interaction.user.id }).catch(() => null);
  if (!submit) return null;
  await submit.deferReply();
  return { value: submit.fields.getTextInputValue("value").trim(), submit };
}

const leaderboardHandlers = {
  "leaderboard channel": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const [kind, timeframe] = kt(ctx);
      const channel = ctx.options.getChannel("channel");
      leaderboards.assertSupported(kind, timeframe);
      guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
      if (kind === "invites") guard.assertBotPermissions(ctx.guild, [P.ManageGuild], "this server (needed to read invite uses)");

      // Moving a board: delete the old message so there aren't two copies.
      const old = store.boards.get(ctx.guild.id, kind, timeframe);
      if (old?.message_id && old.channel_id !== channel.id) {
        const oldChannel = await ctx.guild.channels.fetch(old.channel_id).catch(() => null);
        await oldChannel?.messages?.delete(old.message_id).catch(() => {});
      }
      store.boards.upsertChannel(ctx.guild.id, kind, timeframe, channel.id);
      if (kind === "voice") activity.seedVoiceGuild(ctx.guild);
      if (kind === "invites") await activity.seedInvites(ctx.guild);

      await leaderboards.refresh(ctx.client, ctx.guild.id, kind, timeframe);
      leaderboards.schedule(ctx.guild.id, kind, timeframe);
      const tracking = kind === "levels" ? "" : `\n-# ${fmt.LEADERBOARD_KINDS[kind]} are tracked from now on, for servers with a board of that kind.`;
      await ctx.success(`The ${boardName(kind, timeframe)} leaderboard is in ${channel} and refreshes every 10 minutes.${tracking}`);
    },
  },

  "leaderboard message": {
    gate: "Manage Guild",
    defer: false,
    async run(interaction, ctx) {
      const [kind, timeframe] = kt(ctx);
      const board = requireBoard(ctx.guild.id, kind, timeframe);
      const result = await ctx.promptScript({ title: "Leaderboard message", current: board.script ?? fmt.DEFAULT_BOARD_SCRIPT });
      if (!result) return;
      ensure(/\{(rank|user|value|emote)\}/i.test(result.script), "The message needs a line with `{user}` and `{value}` (repeated once per rank). See `/automation leaderboard variables`.");
      store.boards.setScript(ctx.guild.id, kind, timeframe, result.script);
      await leaderboards.refresh(ctx.client, ctx.guild.id, kind, timeframe);
      await ctx.success(`Updated the ${boardName(kind, timeframe)} leaderboard message.`);
    },
  },

  "leaderboard emote": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const kind = ctx.options.getString("kind");
      const rank = ctx.options.getInteger("rank");
      const text = ctx.options.getString("emote");
      const emote = text ? parse.emoji(text, ctx.client).text : null;
      store.boards.setEmote(ctx.guild.id, kind, rank, emote);
      await ctx.success(`Rank **${rank}** on ${fmt.LEADERBOARD_KINDS[kind]} boards now shows ${emote ?? `${fmt.defaultEmote(rank)} (default)`}.\n-# Boards pick this up on their next refresh.`);
    },
  },

  "leaderboard emotes": {
    gate: "Manage Guild",
    defer: false,
    async run(interaction, ctx) {
      const kind = ctx.options.getString("kind");
      const current = store.boards.emotes(ctx.guild.id, kind);
      const shown = Array.from({ length: fmt.LEADERBOARD_SIZE }, (_, i) => current[i + 1]).filter(Boolean);
      const result = await promptText(interaction, {
        title: `${fmt.LEADERBOARD_KINDS[kind]} rank emotes`,
        label: `Up to ${fmt.LEADERBOARD_SIZE} emojis, rank 1 first (empty = defaults)`,
        value: shown.length === Object.keys(current).length ? shown.join(" ") : "",
        placeholder: "🥇 🥈 🥉 🏅 ⭐",
      });
      if (!result) return;
      ctx.target = result.submit; // replies go to the modal submission
      const list = result.value ? parse.emojis(result.value, ctx.client).map((e) => e.text) : [];
      ensure(list.length <= fmt.LEADERBOARD_SIZE, `Give at most ${fmt.LEADERBOARD_SIZE} emojis (one per rank).`);
      store.boards.setEmotes(ctx.guild.id, kind, list);
      await ctx.success(
        list.length
          ? `${fmt.LEADERBOARD_KINDS[kind]} rank emotes: ${list.map((e, i) => `**${i + 1}** ${e}`).join(" · ")}`
          : `${fmt.LEADERBOARD_KINDS[kind]} boards use the default rank emotes again.`
      );
    },
  },

  "leaderboard resend": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const [kind, timeframe] = kt(ctx);
      const board = requireBoard(ctx.guild.id, kind, timeframe);
      await leaderboards.refresh(ctx.client, ctx.guild.id, kind, timeframe, { resend: true });
      leaderboards.schedule(ctx.guild.id, kind, timeframe);
      await ctx.success(`Posted the ${boardName(kind, timeframe)} leaderboard again in <#${board.channel_id}>.`);
    },
  },

  "leaderboard view": {
    gate: "Manage Guild",
    defer: "ephemeral",
    async run(interaction, ctx) {
      const [kind, timeframe] = kt(ctx);
      leaderboards.assertSupported(kind, timeframe);
      // Works before a board exists too, using the default message.
      const board = store.boards.get(ctx.guild.id, kind, timeframe) ?? { kind, timeframe, script: null };
      await ctx.reply(await leaderboards.payload(ctx.guild, ctx.channel, { ...board, kind, timeframe }));
    },
  },

  "leaderboard remove": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const [kind, timeframe] = kt(ctx);
      const board = requireBoard(ctx.guild.id, kind, timeframe);
      store.boards.remove(ctx.guild.id, kind, timeframe);
      leaderboards.unschedule(ctx.guild.id, kind, timeframe);
      let deleted = false;
      if (ctx.options.getBoolean("delete_message") && board.message_id) {
        const channel = await ctx.guild.channels.fetch(board.channel_id).catch(() => null);
        deleted = await channel?.messages?.delete(board.message_id).then(() => true, () => false);
      }
      await ctx.success(`Removed the ${boardName(kind, timeframe)} leaderboard${deleted ? " and its message" : ""}.`);
    },
  },

  "leaderboard config": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const lines = store.boards.list(ctx.guild.id).map(
        (b) =>
          `${boardName(b.kind, b.timeframe)} in <#${b.channel_id}>${b.message_id ? ` · [message](${messageUrl(b)})` : ""}${b.script ? " · custom message" : ""}`
      );
      await ui.paginate(
        interaction,
        ui.listPages(ctx.client, "Leaderboards", lines, { empty: "No leaderboards yet. Create one with `/automation leaderboard channel`.", footer: "Periods reset at 00:00 UTC; weeks start Monday" })
      );
    },
  },

  "leaderboard variables": {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const lines = Object.entries(fmt.BOARD_VARIABLES).map(([k, v]) => `\`${k}\` ${v}`);
      lines.push("", "Server variables such as `{guild.name}`, `{guild.icon}` and `{guild.count}` also work.");
      lines.push("Default line: `{emote} {user} · **{value}**`");
      await ctx.info(lines.join("\n"), "Leaderboard variables");
    },
  },
};

module.exports = defineCommand({
  data,
  module: "automation",
  handlers: {
    ...paginationHandlers,
    ...pinHandlers,
    ...reposterHandlers,
    ...publisherHandlers,
    ...counterHandlers,
    ...timerHandlers,
    ...leaderboardHandlers,
  },
});
