/**
 * /suggest: the suggestion system (WP5).
 *
 * Members post ideas with /suggest create. They land in the suggestions
 * channel with vote buttons (or first in a review channel when review is on).
 * Staff move them through statuses (Pending, In Consideration, In Progress,
 * Approved, Denied) and reply; the author is DMed unless `silent` is set.
 *
 * Tree: 14 subcommands + 2 groups (review: 2, ignore: 3) = 19 handlers.
 */
const { SlashCommandBuilder, ChannelType, Role } = require("discord.js");
const { defineCommand, guard, ui, parse, embeds, UserError } = require("../../../core");
const store = require("../db");
const render = require("../render");
const service = require("../service");

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

// ---------------------------------------------------------------- builder helpers

const idOption = (s) =>
  s.addIntegerOption((o) => o.setName("id").setDescription("Suggestion number").setRequired(true).setMinValue(1).setAutocomplete(true));
const silentOption = (s) =>
  s.addBooleanOption((o) => o.setName("silent").setDescription("Don't DM the author about this"));
const statusSub = (name, label) => (s) =>
  silentOption(idOption(s.setName(name).setDescription(`Change a suggestion status to ${label}`)));

const data = new SlashCommandBuilder()
  .setName("suggest")
  .setDescription("Suggestion system")
  .addSubcommandGroup((g) =>
    g.setName("review").setDescription("Require staff approval before suggestions are posted")
      .addSubcommand((s) => s.setName("set").setDescription("Enable or disable review of suggestions before they're posted")
        .addBooleanOption((o) => o.setName("setting").setDescription("Review suggestions first?").setRequired(true)))
      .addSubcommand((s) => s.setName("channel").setDescription("Set the review channel for suggestions that require approval")
        .addChannelOption((o) => o.setName("channel").setDescription("Review channel").setRequired(true).addChannelTypes(...TEXT_CHANNELS))))
  .addSubcommandGroup((g) =>
    g.setName("ignore").setDescription("Stop members or roles from creating suggestions")
      .addSubcommand((s) => s.setName("add").setDescription("Prevent a member or role from creating suggestions")
        .addMentionableOption((o) => o.setName("target").setDescription("Member or role").setRequired(true)))
      .addSubcommand((s) => s.setName("remove").setDescription("Allow a member or role to create suggestions again")
        .addMentionableOption((o) => o.setName("target").setDescription("Member or role").setRequired(true)))
      .addSubcommand((s) => s.setName("list").setDescription("List all ignored members or roles")))
  .addSubcommand((s) => s.setName("create").setDescription("Suggest a new idea or feature to server staff")
    .addStringOption((o) => o.setName("suggestion").setDescription("Your idea").setRequired(true).setMaxLength(2000)))
  .addSubcommand((s) => silentOption(idOption(s.setName("reply").setDescription("Reply to a suggestion"))
    .addStringOption((o) => o.setName("comment").setDescription("Your response").setRequired(true).setMaxLength(1000))))
  .addSubcommand(statusSub("consider", "In Consideration"))
  .addSubcommand(statusSub("reset", "Pending"))
  .addSubcommand(statusSub("progress", "In Progress"))
  .addSubcommand(statusSub("deny", "Denied"))
  .addSubcommand(statusSub("approve", "Approved"))
  .addSubcommand((s) => s.setName("config").setDescription("View suggestion system configuration"))
  .addSubcommand((s) => s.setName("lock").setDescription("Disable the suggestion system"))
  .addSubcommand((s) => s.setName("unlock").setDescription("Enable the suggestion system"))
  .addSubcommand((s) => s.setName("set").setDescription("Set the channel for new suggestions")
    .addChannelOption((o) => o.setName("channel").setDescription("Suggestions channel").setRequired(true).addChannelTypes(...TEXT_CHANNELS)))
  .addSubcommand((s) => s.setName("clear").setDescription("Remove the suggestions channel")
    .addStringOption((o) => o.setName("setting").setDescription("What to clear").setRequired(true)
      .addChoices(
        { name: "Suggestions channel", value: "channel" },
        { name: "Review channel", value: "review_channel" },
        { name: "Custom reactions", value: "reactions" }
      )))
  .addSubcommand((s) => s.setName("reactions").setDescription("Set custom reactions for new suggestions")
    .addStringOption((o) => o.setName("upvote").setDescription("Upvote emoji").setRequired(true))
    .addStringOption((o) => o.setName("downvote").setDescription("Downvote emoji").setRequired(true)))
  .addSubcommand((s) => s.setName("threads").setDescription("Create a thread along with the suggestion message")
    .addBooleanOption((o) => o.setName("setting").setDescription("Create threads?").setRequired(true)));

// ---------------------------------------------------------------- handlers

const STAFF = "Staff Only";
const MANAGE = "Manage Channels";

/** Shared by consider / reset / progress / deny / approve. */
const statusHandler = (command) => ({
  gate: STAFF,
  defer: "ephemeral",
  async run(interaction, ctx) {
    const status = render.STATUS_BY_COMMAND[command];
    const id = ctx.options.getInteger("id", true);
    const silent = ctx.options.getBoolean("silent") ?? false;
    const row = service.requireSuggestion(ctx.guild.id, id);
    if (row.status === "review")
      throw new UserError(`Suggestion #${id} is still waiting for review. Use the Approve / Deny buttons in the review channel.`);
    if (row.status === status) throw new UserError(`Suggestion #${id} is already **${render.statusLabel(status)}**.`);

    store.setStatus(ctx.guild.id, id, status, ctx.user.id);
    const updated = store.getSuggestion(ctx.guild.id, id);
    const edited = await service.refresh(ctx.guild, updated);
    const dmed = silent
      ? false
      : await service.notifyAuthor(ctx.client, ctx.guild, updated, {
          title: `Suggestion #${id}: ${render.statusLabel(status)}`,
          text: `Your suggestion in **${ctx.guild.name}** was marked **${render.statusLabel(status)}** by ${ctx.user}.`,
        });
    await ctx.success(
      [
        `Suggestion #${id} is now **${render.statusLabel(status)}**.`,
        edited ? null : "The suggestion message couldn't be found, so only the record was updated.",
        silent ? null : dmed ? "The author was notified." : "I couldn't DM the author.",
      ].filter(Boolean).join("\n")
    );
  },
});

/** The `target` option (member or role) as { id, kind, text }. */
function mentionable(ctx) {
  const target = ctx.options.getMentionable("target", true);
  const isRole = target instanceof Role;
  return { id: target.id, kind: isRole ? "role" : "member", text: isRole ? `<@&${target.id}>` : `<@${target.id}>` };
}

const handlers = {
  // ----------------------------------------------------- review
  "review set": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const enabled = ctx.options.getBoolean("setting", true);
      store.updateSettings(ctx.guild.id, { review_enabled: enabled });
      const settings = store.getSettings(ctx.guild.id);
      const note = enabled && !settings.review_channel_id ? "\nSet a review channel with `/suggest review channel`, or suggestions can't be created." : "";
      await ctx.success(`Suggestion review is now **${enabled ? "on" : "off"}**.${note}`);
    },
  },
  "review channel": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel", true);
      guard.assertBotPermissions(channel, service.SEND_PERMS);
      store.updateSettings(ctx.guild.id, { review_channel_id: channel.id });
      const settings = store.getSettings(ctx.guild.id);
      await ctx.success(
        `Suggestions needing approval will go to ${channel}.${settings.review_enabled ? "" : "\nReview is off; turn it on with `/suggest review set`."}`
      );
    },
  },

  // ----------------------------------------------------- ignore
  "ignore add": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const t = mentionable(ctx);
      if (!store.addIgnore(ctx.guild.id, t.id, t.kind)) throw new UserError(`${t.text} is already ignored.`);
      await ctx.success(`${t.text} can no longer create suggestions.`);
    },
  },
  "ignore remove": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const t = mentionable(ctx);
      if (!store.removeIgnore(ctx.guild.id, t.id)) throw new UserError(`${t.text} isn't ignored.`);
      await ctx.success(`${t.text} can create suggestions again.`);
    },
  },
  "ignore list": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const lines = store.listIgnores(ctx.guild.id).map((r) => (r.kind === "role" ? `Role: <@&${r.target_id}>` : `Member: <@${r.target_id}>`));
      await ui.paginate(interaction, ui.listPages(ctx.client, "Suggestion ignores", lines, { empty: "Nobody is ignored." }));
    },
  },

  // ----------------------------------------------------- create / reply
  create: {
    defer: "ephemeral",
    async run(interaction, ctx) {
      const content = ctx.options.getString("suggestion", true).trim();
      if (!content) throw new UserError("Your suggestion is empty.");
      const { row, message, thread, review } = await service.submit(ctx.member, content);
      const lines = review
        ? [`Your suggestion **#${row.id}** was sent to staff for review. You'll get a DM when it's handled (if your DMs are open).`]
        : [`Your suggestion **#${row.id}** was posted: ${message.url}`, thread ? `Discussion thread: ${thread}` : null];
      await ctx.success(lines.filter(Boolean).join("\n"));
    },
  },
  reply: {
    gate: STAFF,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const id = ctx.options.getInteger("id", true);
      const comment = ctx.options.getString("comment", true).trim();
      const silent = ctx.options.getBoolean("silent") ?? false;
      const row = service.requireSuggestion(ctx.guild.id, id);
      if (!comment) throw new UserError("Your reply is empty.");
      store.addReply(ctx.guild.id, id, ctx.user.id, comment);
      const edited = await service.refresh(ctx.guild, row);
      const dmed = silent
        ? false
        : await service.notifyAuthor(ctx.client, ctx.guild, row, {
            title: `Staff replied to suggestion #${id}`,
            text: `${ctx.user} replied:\n${comment}`,
          });
      await ctx.success(
        [
          `Replied to suggestion #${id}.`,
          edited ? null : "The suggestion message couldn't be found, so the reply was only saved.",
          silent ? null : dmed ? "The author was notified." : "I couldn't DM the author.",
        ].filter(Boolean).join("\n")
      );
    },
  },

  // ----------------------------------------------------- status changes
  consider: statusHandler("consider"),
  reset: statusHandler("reset"),
  progress: statusHandler("progress"),
  deny: statusHandler("deny"),
  approve: statusHandler("approve"),

  // ----------------------------------------------------- settings
  config: {
    gate: MANAGE,
    async run(interaction, ctx) {
      const s = store.getSettings(ctx.guild.id);
      const channel = (id) => (id ? `<#${id}>` : "Not set");
      const onOff = (v) => (v ? "On" : "Off");
      const embed = embeds.info(ctx.client, "Current suggestion settings.", "Suggestion configuration").addFields(
        { name: "Status", value: s.locked ? "Locked" : "Open", inline: true },
        { name: "Suggestions channel", value: channel(s.channel_id), inline: true },
        { name: "Threads", value: onOff(s.threads), inline: true },
        { name: "Review", value: onOff(s.review_enabled), inline: true },
        { name: "Review channel", value: channel(s.review_channel_id), inline: true },
        { name: "Vote emojis", value: `${s.upvote || render.DEFAULT_UP} / ${s.downvote || render.DEFAULT_DOWN}`, inline: true },
        { name: "Ignored", value: String(store.listIgnores(ctx.guild.id).length), inline: true }
      );
      await ctx.reply({ embeds: [embed] });
    },
  },
  lock: {
    gate: MANAGE,
    async run(interaction, ctx) {
      if (store.getSettings(ctx.guild.id).locked) throw new UserError("Suggestions are already locked.");
      store.updateSettings(ctx.guild.id, { locked: true });
      await ctx.success("Suggestions are now **locked**. Nobody can create new ones until `/suggest unlock`.");
    },
  },
  unlock: {
    gate: MANAGE,
    async run(interaction, ctx) {
      if (!store.getSettings(ctx.guild.id).locked) throw new UserError("Suggestions aren't locked.");
      store.updateSettings(ctx.guild.id, { locked: false });
      await ctx.success("Suggestions are **unlocked**.");
    },
  },
  set: {
    gate: MANAGE,
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel", true);
      guard.assertBotPermissions(channel, service.SEND_PERMS);
      store.updateSettings(ctx.guild.id, { channel_id: channel.id });
      const settings = store.getSettings(ctx.guild.id);
      let note = "";
      if (settings.threads && !channel.permissionsFor(ctx.guild.members.me)?.has(service.THREAD_PERMS))
        note = "\nThreads are on, but I can't create threads there (need Create Public Threads and Send Messages in Threads).";
      await ctx.success(`New suggestions will be posted in ${channel}.${note}`);
    },
  },
  clear: {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const setting = ctx.options.getString("setting", true);
      const labels = { channel: "the suggestions channel", review_channel: "the review channel", reactions: "the custom vote emojis" };
      if (!(await ui.confirm(interaction, `Clear ${labels[setting]}?`))) return;
      const changes = {
        channel: { channel_id: null },
        review_channel: { review_channel_id: null },
        reactions: { upvote: null, downvote: null },
      }[setting];
      if (!changes) throw new UserError("Unknown setting.");
      store.updateSettings(ctx.guild.id, changes);
      await ctx.success(
        setting === "reactions"
          ? `Cleared ${labels[setting]}; new votes use ${render.DEFAULT_UP} / ${render.DEFAULT_DOWN}.`
          : `Cleared ${labels[setting]}.`
      );
    },
  },
  reactions: {
    gate: MANAGE,
    async run(interaction, ctx) {
      // With the client, custom emojis the bot can't use are rejected.
      const up = parse.emoji(ctx.options.getString("upvote", true), ctx.client);
      const down = parse.emoji(ctx.options.getString("downvote", true), ctx.client);
      if (parse.emojiKey(up) === parse.emojiKey(down)) throw new UserError("Upvote and downvote need different emojis.");
      store.updateSettings(ctx.guild.id, { upvote: up.text, downvote: down.text });
      await ctx.success(`Vote buttons now use ${up.text} / ${down.text}. Existing suggestions update the next time they change.`);
    },
  },
  threads: {
    gate: MANAGE,
    async run(interaction, ctx) {
      const enabled = ctx.options.getBoolean("setting", true);
      const settings = store.getSettings(ctx.guild.id);
      if (enabled && settings.channel_id) {
        const channel = await service.getChannel(ctx.guild, settings.channel_id);
        if (channel) guard.assertBotPermissions(channel, service.THREAD_PERMS);
      }
      store.updateSettings(ctx.guild.id, { threads: enabled });
      await ctx.success(`Discussion threads for new suggestions are now **${enabled ? "on" : "off"}**.`);
    },
  },
};

// ---------------------------------------------------------------- autocomplete

/** Recent suggestions, or ones matching what the user typed. */
function suggestionChoices(interaction, ctx) {
  const typed = String(ctx.focused?.value ?? "").trim();
  const rows = typed ? store.searchSuggestions(ctx.guild.id, typed) : store.recentSuggestions(ctx.guild.id);
  return rows.map(render.autocompleteChoice);
}

const autocomplete = Object.fromEntries(["reply", "consider", "reset", "progress", "deny", "approve"].map((k) => [k, suggestionChoices]));

module.exports = defineCommand({ data, module: "suggest", handlers, autocomplete });
