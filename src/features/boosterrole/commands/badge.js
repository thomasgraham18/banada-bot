/**
 * /badge: reward members who display this server's guild tag (9 subcommands).
 *
 *   message set | view
 *   role    add | remove | list
 *   set  channel  clear  sync
 *
 * Detection lives in ../badge.js (userUpdate / guildMemberUpdate + a periodic sweep).
 */
const { SlashCommandBuilder, ChannelType, GuildFeature, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, embeds, guard, scheduler, script, ui, ensure } = require("../../../core");
const store = require("../db");
const badge = require("../badge");

const MAX_ROLES = 10;
const VARS_HELP = "Extra variables: `{tag}` (the tag text) and `{tag.badge}` (badge image URL), plus the usual `{user.mention}`, `{guild.name}`...";

module.exports = defineCommand({
  data: new SlashCommandBuilder()
    .setName("badge")
    .setDescription("Reward members who wear this server's guild tag")
    .addSubcommandGroup((g) =>
      g.setName("message").setDescription("The award message")
        .addSubcommand((s) => s.setName("set").setDescription("Set an award message with a script or regular text"))
        .addSubcommand((s) => s.setName("view").setDescription("View current award message")))
    .addSubcommandGroup((g) =>
      g.setName("role").setDescription("Roles awarded for wearing the guild tag")
        .addSubcommand((s) => s.setName("add").setDescription("Add a role awarded for applying the guild tag")
          .addRoleOption((o) => o.setName("role").setDescription("Role to award").setRequired(true)))
        .addSubcommand((s) => s.setName("remove").setDescription("Remove a role awarded for applying the guild tag")
          .addRoleOption((o) => o.setName("role").setDescription("Role to stop awarding").setRequired(true)))
        .addSubcommand((s) => s.setName("list").setDescription("List all roles awarded for applying the guild tag")))
    .addSubcommand((s) => s.setName("set").setDescription("Enable or disable the guild tag reward system")
      .addBooleanOption((o) => o.setName("setting").setDescription("True to enable").setRequired(true)))
    .addSubcommand((s) => s.setName("channel").setDescription("Set an award channel for new guild tag members")
      .addChannelOption((o) => o.setName("channel").setDescription("Where award messages are posted").setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName("clear").setDescription("Remove the award channel or message")
      .addStringOption((o) => o.setName("setting").setDescription("What to remove").setRequired(true)
        .addChoices({ name: "channel", value: "channel" }, { name: "message", value: "message" })))
    .addSubcommand((s) => s.setName("sync").setDescription("Sync guild tag member roles")),

  handlers: {
    "message set": {
      gate: "Manage Guild",
      defer: false, // opens a modal
      run: async (interaction, ctx) => {
        const result = await ctx.promptScript({ title: "Guild tag award message", current: store.badge.get(ctx.guild.id).script ?? badge.DEFAULT_SCRIPT });
        if (!result) return;
        store.badge.set(ctx.guild.id, "script", result.script);
        return ctx.success(`Award message saved. Preview it with \`/badge message view\`.\n${VARS_HELP}`);
      },
    },
    "message view": {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        const cfg = store.badge.get(ctx.guild.id);
        const preview = script.render(cfg.script || badge.DEFAULT_SCRIPT, script.previewContext(interaction, badge.tagVars(ctx.user)));
        const header = embeds.info(ctx.client, `${cfg.script ? "Current award message" : "No message set; this is the default"}. Preview with your own account:\n${VARS_HELP}`, "Guild tag award message");
        return ctx.reply({ ...preview, embeds: [header, ...preview.embeds].slice(0, 10) });
      },
    },

    "role add": {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        const role = interaction.options.getRole("role");
        guard.assertManageableRole(ctx.member, role);
        const cfg = store.badge.get(ctx.guild.id);
        ensure(cfg.roleIds.length < MAX_ROLES, `You can award at most ${MAX_ROLES} roles.`);
        ensure(store.badge.addRole(ctx.guild.id, role.id), `${role} is already awarded.`);
        return ctx.success(`Members wearing the guild tag now get ${role}.${cfg.enabled ? " Run `/badge sync` to give it to current wearers." : " Turn the system on with `/badge set true`."}`);
      },
    },
    "role remove": {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        const role = interaction.options.getRole("role");
        ensure(store.badge.removeRole(ctx.guild.id, role.id), `${role} isn't an award role.`);
        return ctx.success(`${role} is no longer awarded. Members who have it keep it.`);
      },
    },
    "role list": {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        const cfg = store.badge.get(ctx.guild.id);
        return ui.paginate(interaction, ui.listPages(ctx.client, "Guild tag award roles", cfg.roleIds.map((id) => `<@&${id}>`), {
          empty: "No award roles. Add one with `/badge role add`.",
          footer: `${cfg.enabled ? "Enabled" : "Disabled"} • ${cfg.members.size} member(s) wearing the tag`,
        }));
      },
    },

    set: {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        const enabled = interaction.options.getBoolean("setting");
        store.badge.set(ctx.guild.id, "enabled", enabled);
        if (!enabled) {
          scheduler.cancel(badge.SWEEP_KIND, ctx.guild.id);
          return ctx.success("Guild tag rewards are **disabled**. Members keep the roles they have.");
        }
        badge.scheduleSweep(ctx.guild.id);
        // Baseline: record (and reward) everyone already wearing the tag, without
        // flooding the award channel with messages for old adopters.
        const result = await badge.syncGuild(ctx.guild, { announce: false });
        const notes = [];
        if (!store.badge.get(ctx.guild.id).roleIds.length) notes.push("No award roles yet: add one with `/badge role add`.");
        if (!ctx.guild.features.includes(GuildFeature.GuildTags)) notes.push("Note: Discord doesn't list the guild tags feature for this server, so nobody may be able to wear its tag yet.");
        return ctx.success([`Guild tag rewards are **enabled**. **${result.wearing}** member(s) currently wear the tag.`, ...notes].join("\n"));
      },
    },
    channel: {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        const channel = interaction.options.getChannel("channel");
        guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
        store.badge.set(ctx.guild.id, "channel_id", channel.id);
        return ctx.success(`Award messages will be posted in ${channel}.`);
      },
    },
    clear: {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        const setting = interaction.options.getString("setting");
        const cfg = store.badge.get(ctx.guild.id);
        if (setting === "channel") {
          ensure(cfg.channelId, "No award channel is set.");
          store.badge.set(ctx.guild.id, "channel_id", null);
          return ctx.success("Removed the award channel. No award messages will be posted.");
        }
        ensure(cfg.script, "No custom award message is set.");
        store.badge.set(ctx.guild.id, "script", null);
        return ctx.success("Removed the award message; the default one will be used.");
      },
    },
    sync: {
      gate: "Manage Guild",
      run: async (interaction, ctx) => {
        ensure(store.badge.get(ctx.guild.id).enabled, "Guild tag rewards are disabled. Enable them with `/badge set true`.");
        const r = await badge.syncGuild(ctx.guild, { announce: false });
        return ctx.success(`Scanned **${r.scanned}** members: **${r.wearing}** wear the tag. Rewarded **${r.added}** new, removed rewards from **${r.removed}**.`);
      },
    },
  },
});
