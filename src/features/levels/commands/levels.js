/**
 * /levels: XP, ranks and level roles (guide WP10).
 *
 * 22 top-level entries (3 groups + 19 subcommands), 27 subcommands in total.
 * Public: rank, roles, leaderboard view, messages. Owner-only: cleanup, reset.
 * Everything else needs Manage Guild (checked at runtime by the router).
 */
const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, ensure, embeds, guard, script, ui } = require("../../../core");
const store = require("../db");
const formula = require("../formula");
const { applyLevelRoles, levelVars, LEVEL_VARIABLES } = require("../service");

const { MAX_LEVEL, MAX_XP, MIN_MULTIPLIER, MAX_MULTIPLIER } = formula;
const fmt = (n) => Number(n).toLocaleString("en-US");
const MODE_TEXT = { here: "the channel the member is talking in", channel: "a set channel", dm: "direct messages", off: "nowhere (off)" };

// ---------------------------------------------------------------- tree

const memberOpt = (o) => o.setName("member").setDescription("The member").setRequired(true);
const rankOpt = (required, autocomplete = false) => (o) =>
  o.setName("rank").setDescription("The level").setRequired(required).setMinValue(1).setMaxValue(MAX_LEVEL).setAutocomplete(autocomplete);

const data = new SlashCommandBuilder()
  .setName("levels")
  .setDescription("Levelling: XP, ranks and level roles")
  .addSubcommandGroup((g) =>
    g.setName("leaderboard").setDescription("The server leaderboard")
      .addSubcommand((s) => s.setName("view").setDescription("View the highest ranking members"))
      .addSubcommand((s) => s.setName("rename").setDescription("Set the title of the leaderboard embeds")
        .addStringOption((o) => o.setName("text").setDescription("New title (leave empty to reset)").setMaxLength(200))))
  .addSubcommandGroup((g) =>
    g.setName("message").setDescription("The level up message")
      .addSubcommand((s) => s.setName("set").setDescription("Set the level up message (text or JSON script; 'default' resets)")
        .addStringOption((o) => o.setName("text").setDescription("Message script. Variables: {level} {xp} {next_level} {next_xp} {rank} {role}").setRequired(true).setMaxLength(6000)))
      .addSubcommand((s) => s.setName("view").setDescription("Preview the level up message for this server")))
  .addSubcommandGroup((g) =>
    g.setName("messagemode").setDescription("Where level up messages are sent")
      .addSubcommand((s) => s.setName("channel").setDescription("Send level up messages to one channel")
        .addChannelOption((o) => o.setName("channel").setDescription("The channel").setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand((s) => s.setName("dm").setDescription("Send level up messages to the member directly"))
      .addSubcommand((s) => s.setName("here").setDescription("Send level up messages to the channel the member is talking in"))
      .addSubcommand((s) => s.setName("off").setDescription("Stop sending level up messages")))
  .addSubcommand((s) => s.setName("rank").setDescription("View a member's level and experience")
    .addUserOption((o) => o.setName("member").setDescription("The member (default: you)")))
  .addSubcommand((s) => s.setName("roles").setDescription("View every level role"))
  .addSubcommand((s) => s.setName("config").setDescription("View this server's leveling configuration"))
  .addSubcommand((s) => s.setName("list").setDescription("View every ignored channel and no-XP role"))
  .addSubcommand((s) => s.setName("add").setDescription("Award a role at a given level")
    .addRoleOption((o) => o.setName("role").setDescription("The role to award").setRequired(true))
    .addIntegerOption(rankOpt(true)))
  .addSubcommand((s) => s.setName("update").setDescription("Change which role a level awards")
    .addRoleOption((o) => o.setName("role").setDescription("The new role").setRequired(true))
    .addIntegerOption(rankOpt(true, true)))
  .addSubcommand((s) => s.setName("remove").setDescription("Remove the role awarded at a level")
    .addIntegerOption(rankOpt(true, true)))
  .addSubcommand((s) => s.setName("sync").setDescription("Give everyone the level roles they have earned"))
  .addSubcommand((s) => s.setName("setrate").setDescription("Set the XP multiplier for this server")
    .addNumberOption((o) => o.setName("multiplier").setDescription(`${MIN_MULTIPLIER}–${MAX_MULTIPLIER} (1 = normal)`).setRequired(true)
      .setMinValue(MIN_MULTIPLIER).setMaxValue(MAX_MULTIPLIER)))
  .addSubcommand((s) => s.setName("stackroles").setDescription("Enable or disable stacking of level roles")
    .addBooleanOption((o) => o.setName("setting").setDescription("True: keep every earned role. False: only the highest").setRequired(true)))
  .addSubcommand((s) => s.setName("messages").setDescription("Enable or disable your own level up messages")
    .addBooleanOption((o) => o.setName("setting").setDescription("True to receive them, false to mute them").setRequired(true)))
  .addSubcommand((s) => s.setName("ignore").setDescription("Ignore a channel or role for XP (run again to un-ignore)")
    .addRoleOption((o) => o.setName("role").setDescription("Members with this role earn no XP"))
    .addChannelOption((o) => o.setName("channel").setDescription("Messages here earn no XP (categories cover their channels)")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
        ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory)))
  .addSubcommand((s) => s.setName("unlock").setDescription("Turn the leveling system on"))
  .addSubcommand((s) => s.setName("lock").setDescription("Turn the leveling system off"))
  .addSubcommand((s) => s.setName("cleanup").setDescription("Reset level and XP for members who have left"))
  .addSubcommand((s) => s.setName("reset").setDescription("Reset level and XP for every member"))
  .addSubcommand((s) => s.setName("setxp").setDescription("Set a member's experience")
    .addUserOption(memberOpt)
    .addIntegerOption((o) => o.setName("amount").setDescription("Total XP").setRequired(true).setMinValue(0).setMaxValue(MAX_XP)))
  .addSubcommand((s) => s.setName("setlevel").setDescription("Set a member's level")
    .addUserOption(memberOpt)
    .addIntegerOption((o) => o.setName("level").setDescription("The level").setRequired(true).setMinValue(0).setMaxValue(MAX_LEVEL)))
  .addSubcommand((s) => s.setName("removexp").setDescription("Remove experience from a member")
    .addUserOption(memberOpt)
    .addIntegerOption((o) => o.setName("amount").setDescription("XP to remove").setRequired(true).setMinValue(1).setMaxValue(MAX_XP)));

// ---------------------------------------------------------------- helpers

const roleLine = (guild, r) => `**Level ${r.level}** → ${guild.roles.cache.has(r.roleId) ? `<@&${r.roleId}>` : `deleted role (${r.roleId})`}`;

/**
 * Stores a member's new XP and, if they're in the server, fixes their level
 * roles. Returns a sentence for the reply.
 */
async function writeXp(ctx, user, xp) {
  const { xp: total, level } = store.setXp(ctx.guild.id, user.id, xp);
  let note = "";
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  if (member) {
    try {
      const { added, removed } = await applyLevelRoles(member, level, undefined, `Levels changed by ${ctx.user.tag}`);
      if (added.length || removed.length) note = `\nRoles: ${[...added.map((id) => `+<@&${id}>`), ...removed.map((id) => `-<@&${id}>`)].join(" ")}`;
    } catch (err) {
      note = `\nI couldn't update their level roles (${err.message}).`;
    }
  }
  return `${user} now has **${fmt(total)} XP** (level **${level}**).${note}`;
}

/** Ensures the role can be a level role (hierarchy etc.) and isn't used by another level. */
function assertLevelRole(ctx, role, level) {
  guard.assertManageableRole(ctx.member, role);
  const other = store.settings.get(ctx.guild.id).roles.find((r) => r.roleId === role.id && r.level !== level);
  ensure(!other, `${role} is already awarded at level ${other?.level}. Remove it there first.`);
}

const rankChoices = (interaction) =>
  store.settings.get(interaction.guildId).roles.map((r) => ({
    name: `Level ${r.level} → ${interaction.guild.roles.cache.get(r.roleId)?.name ?? "deleted role"}`,
    value: r.level,
  }));

// ---------------------------------------------------------------- handlers

const handlers = {
  // ---------------- leaderboard
  "leaderboard view": async (interaction, ctx) => {
    const rows = store.getLeaderboard(ctx.guild.id, { limit: 100 });
    const title = store.settings.get(ctx.guild.id).leaderboardTitle ?? `${ctx.guild.name} leaderboard`;
    const lines = rows.map((r, i) => `\`${i + 1}.\` <@${r.userId}> · Level **${r.level}** · ${fmt(r.xp)} XP`);
    const pages = ui.listPages(ctx.client, title, lines, { perPage: 10, empty: "Nobody has earned XP yet." });
    await ui.paginate(interaction, pages);
  },
  "leaderboard rename": {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const text = ctx.options.getString("text")?.trim() || null;
      store.updateConfig(ctx.guild.id, { leaderboard_title: text });
      await ctx.success(text ? `Leaderboard title set to **${text}**.` : "Leaderboard title reset to the default.");
    },
  },

  // ---------------- level-up message
  "message set": {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const text = ctx.options.getString("text", true).trim();
      if (text.toLowerCase() === "default") {
        store.updateConfig(ctx.guild.id, { script: null });
        return ctx.success("Level up message reset to the default.");
      }
      store.updateConfig(ctx.guild.id, { script: script.validate(text) });
      await ctx.success("Level up message saved. Preview it with `/levels message view`.");
    },
  },
  "message view": {
    gate: "Manage Guild",
    defer: "ephemeral",
    run: async (interaction, ctx) => {
      const settings = store.settings.get(ctx.guild.id);
      const xp = store.getXp(ctx.guild.id, ctx.user.id);
      const preview = script.render(settings.script, script.previewContext(interaction, levelVars(ctx.guild.id, xp, settings.roles[0]?.roleId)));
      const help = embeds.info(ctx.client,
        [
          `Mode: **${settings.messageMode}**${settings.messageMode === "channel" ? ` (<#${settings.messageChannelId}>)` : ""}${settings.customScript ? "" : " · default message"}`,
          "",
          ...Object.entries(LEVEL_VARIABLES).map(([k, v]) => `\`${k}\` ${v}`),
          "",
          "Plus the usual `{user.mention}`, `{guild.name}`… variables.",
          "```",
          settings.script.slice(0, 3000),
          "```",
        ].join("\n"), "Level up message");
      await ctx.reply({ ...preview, embeds: [...preview.embeds, help].slice(0, 10) });
    },
  },

  // ---------------- message mode
  "messagemode channel": {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const channel = ctx.options.getChannel("channel", true);
      guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
      store.updateConfig(ctx.guild.id, { message_mode: "channel", message_channel_id: channel.id });
      await ctx.success(`Level up messages will be sent to ${channel}.`);
    },
  },
  ...Object.fromEntries(
    ["dm", "here", "off"].map((mode) => [
      `messagemode ${mode}`,
      {
        gate: "Manage Guild",
        run: async (interaction, ctx) => {
          store.updateConfig(ctx.guild.id, { message_mode: mode });
          await ctx.success(`Level up messages will be sent to ${MODE_TEXT[mode]}.`);
        },
      },
    ])
  ),

  // ---------------- public views
  rank: async (interaction, ctx) => {
    const user = ctx.options.getUser("member") ?? ctx.user;
    const member = ctx.options.getMember("member") ?? (user.id === ctx.user.id ? ctx.member : null);
    const row = store.getMember(ctx.guild.id, user.id);
    const p = formula.progress(row?.xp ?? 0);
    const ranked = p.xp > 0;
    const embed = new EmbedBuilder()
      .setColor(embeds.brand(ctx.client))
      .setAuthor({ name: member?.displayName ?? user.username, iconURL: user.displayAvatarURL({ size: 128 }) })
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "Level", value: `**${p.level}**`, inline: true },
        { name: "Total XP", value: fmt(p.xp), inline: true },
        { name: "Rank", value: ranked ? `#${store.rankOf(ctx.guild.id, p.xp)} of ${fmt(store.rankedCount(ctx.guild.id))}` : "Unranked", inline: true },
        {
          name: p.needed ? `Progress to level ${p.nextLevel}` : "Progress",
          value: p.needed ? `${formula.progressBar(p.current, p.needed)} ${fmt(p.current)} / ${fmt(p.needed)} XP` : "Max level reached",
        }
      );
    if (!store.settings.get(ctx.guild.id).enabled) embed.setFooter({ text: "Levelling is currently locked on this server." });
    await ctx.reply({ embeds: [embed] });
  },
  roles: async (interaction, ctx) => {
    const settings = store.settings.get(ctx.guild.id);
    const lines = settings.roles.map((r) => roleLine(ctx.guild, r));
    const pages = ui.listPages(ctx.client, "Level roles", lines, {
      empty: "No level roles yet. Add one with `/levels add`.",
      footer: settings.stackRoles ? "Roles stack" : "Only the highest role is kept",
    });
    await ui.paginate(interaction, pages);
  },
  config: {
    gate: "Manage Guild",
    defer: "ephemeral",
    run: async (interaction, ctx) => {
      const s = store.settings.get(ctx.guild.id);
      const embed = embeds.info(ctx.client, formula.FORMULA_TEXT, "Leveling configuration").addFields(
        { name: "Status", value: s.enabled ? "Unlocked (on)" : "Locked (off): `/levels unlock`", inline: true },
        { name: "XP rate", value: `${s.multiplier}×`, inline: true },
        { name: "Stack roles", value: s.stackRoles ? "Yes" : "No (highest only)", inline: true },
        { name: "Level up messages", value: s.messageMode === "channel" ? `<#${s.messageChannelId}>` : MODE_TEXT[s.messageMode], inline: true },
        { name: "Message", value: s.customScript ? "Custom" : "Default", inline: true },
        { name: "Leaderboard title", value: s.leaderboardTitle ?? "Default", inline: true },
        { name: "Level roles", value: String(s.roles.length), inline: true },
        { name: "Ignored", value: `${s.ignoredChannels.size} channel(s), ${s.ignoredRoles.size} role(s)`, inline: true },
        { name: "Members with XP", value: fmt(store.rankedCount(ctx.guild.id)), inline: true }
      );
      await ctx.reply({ embeds: [embed] });
    },
  },
  list: {
    gate: "Manage Guild",
    defer: "ephemeral",
    run: async (interaction, ctx) => {
      const s = store.settings.get(ctx.guild.id);
      const lines = [...[...s.ignoredChannels].map((id) => `Channel: <#${id}>`), ...[...s.ignoredRoles].map((id) => `Role: <@&${id}>`)];
      await ui.paginate(interaction, ui.listPages(ctx.client, "Ignored for XP", lines, { empty: "Nothing is ignored. Use `/levels ignore`." }));
    },
  },

  // ---------------- level roles
  add: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const role = ctx.options.getRole("role", true);
      const level = ctx.options.getInteger("rank", true);
      const existing = store.settings.get(ctx.guild.id).roles.find((r) => r.level === level);
      ensure(!existing, `Level ${level} already awards <@&${existing?.roleId}>. Use \`/levels update\` to change it.`);
      assertLevelRole(ctx, role, level);
      store.setLevelRole(ctx.guild.id, level, role.id);
      await ctx.success(`Members reaching **level ${level}** will get ${role}. Run \`/levels sync\` to give it to members already there.`);
    },
  },
  update: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const role = ctx.options.getRole("role", true);
      const level = ctx.options.getInteger("rank", true);
      const existing = store.settings.get(ctx.guild.id).roles.find((r) => r.level === level);
      ensure(existing, `No role is awarded at level ${level}. Use \`/levels add\` first.`);
      assertLevelRole(ctx, role, level);
      store.setLevelRole(ctx.guild.id, level, role.id);
      await ctx.success(`Level **${level}** now awards ${role} instead of <@&${existing.roleId}>. Run \`/levels sync\` to update members.`);
    },
  },
  remove: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const level = ctx.options.getInteger("rank", true);
      ensure(store.removeLevelRole(ctx.guild.id, level), `No role is awarded at level ${level}.`);
      await ctx.success(`Level **${level}** no longer awards a role. Members keep it until you remove it or run \`/levels sync\`.`);
    },
  },
  sync: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const guild = ctx.guild;
      const settings = store.settings.get(guild.id);
      ensure(settings.roles.length, "There are no level roles to sync. Add one with `/levels add`.");
      guard.assertBotPermissions(guild, [P.ManageRoles]);
      const unmanageable = settings.roles.filter((r) => !guard.botCanManageRole(guild, guild.roles.cache.get(r.roleId)));

      await ctx.info("Fetching members…", "Syncing level roles");
      const members = [...(await guild.members.fetch()).values()].filter((m) => !m.user.bot);
      const levels = store.levelsByUser(guild.id);

      // Small parallel batches: discord.js queues requests per route and
      // handles rate limits, the batches just keep the burst (and memory) small.
      const BATCH = 10;
      let changed = 0;
      let failed = 0;
      let lastEdit = Date.now();
      const batches = ui.chunk(members, BATCH);
      for (const [i, batch] of batches.entries()) {
        await Promise.all(
          batch.map(async (member) => {
            try {
              const { added, removed } = await applyLevelRoles(member, levels.get(member.id) ?? 0, settings, `/levels sync by ${ctx.user.tag}`);
              if (added.length || removed.length) changed++;
            } catch {
              failed++;
            }
          })
        );
        if (Date.now() - lastEdit > 5000 && i < batches.length - 1) {
          lastEdit = Date.now();
          await ctx.info(`Processed ${fmt((i + 1) * BATCH)} / ${fmt(members.length)} members…`, "Syncing level roles").catch(() => {});
        }
      }

      const notes = [
        `Checked **${fmt(members.length)}** members; updated **${fmt(changed)}**.`,
        failed ? `${fmt(failed)} member(s) could not be updated.` : null,
        unmanageable.length ? `Skipped roles I can't manage: ${unmanageable.map((r) => roleLine(guild, r)).join(", ")}` : null,
      ];
      await ctx.success(notes.filter(Boolean).join("\n"));
    },
  },

  // ---------------- settings
  setrate: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const multiplier = formula.clampMultiplier(ctx.options.getNumber("multiplier", true));
      store.updateConfig(ctx.guild.id, { multiplier });
      await ctx.success(`Members now earn **${multiplier}×** XP (${formula.rollXp(multiplier, () => 0)}–${formula.rollXp(multiplier, () => 0.999)} per message).`);
    },
  },
  stackroles: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const stack = ctx.options.getBoolean("setting", true);
      store.updateConfig(ctx.guild.id, { stack_roles: stack });
      await ctx.success(
        (stack ? "Members now keep every level role they earn." : "Members now keep only their highest level role.") +
          " Run `/levels sync` to apply this to everyone."
      );
    },
  },
  messages: {
    defer: "ephemeral",
    run: async (interaction, ctx) => {
      const on = ctx.options.getBoolean("setting", true);
      store.setOptOut(ctx.guild.id, ctx.user.id, !on);
      await ctx.success(on ? "You'll get level up messages again." : "You won't get level up messages any more.");
    },
  },
  ignore: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const role = ctx.options.getRole("role");
      const channel = ctx.options.getChannel("channel");
      ensure(role || channel, "Pick a `role`, a `channel`, or both.");
      ensure(!role || role.id !== ctx.guild.id, "Ignoring @everyone would stop all XP. Use `/levels lock` instead.");
      const lines = [];
      if (role) lines.push(`${role}: ${store.toggleIgnore(ctx.guild.id, role.id, "role") ? "now earns **no XP**" : "earns XP again"}`);
      if (channel) lines.push(`${channel}: ${store.toggleIgnore(ctx.guild.id, channel.id, "channel") ? "now earns **no XP**" : "earns XP again"}`);
      await ctx.success(lines.join("\n"));
    },
  },
  unlock: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      store.updateConfig(ctx.guild.id, { enabled: true });
      await ctx.success("Levelling is **on**. Members earn XP for chatting.");
    },
  },
  lock: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      store.updateConfig(ctx.guild.id, { enabled: false });
      await ctx.success("Levelling is **off**. XP and roles are kept.");
    },
  },

  // ---------------- destructive (owner only, confirmed)
  cleanup: {
    gate: "Server Owner",
    defer: "ephemeral",
    run: async (interaction, ctx) => {
      if (!(await ui.confirm(interaction, "Delete the level and XP of every member who has **left** this server?"))) return;
      const present = await ctx.guild.members.fetch(); // needs the GuildMembers intent
      const gone = store.allUserIds(ctx.guild.id).filter((id) => !present.has(id));
      const removed = store.deleteMembers(ctx.guild.id, gone);
      await ctx.success(`Removed level data for **${fmt(removed)}** former member(s).`);
    },
  },
  reset: {
    gate: "Server Owner",
    defer: "ephemeral",
    run: async (interaction, ctx) => {
      if (!(await ui.confirm(interaction, "Reset the level and XP of **every** member? Level roles they already have are not removed (run `/levels sync` after)."))) return;
      const n = store.resetGuild(ctx.guild.id);
      await ctx.success(`Reset XP for **${fmt(n)}** member(s).`);
    },
  },

  // ---------------- manual XP
  setxp: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const user = ctx.options.getUser("member", true);
      ensure(!user.bot, "Bots don't earn XP.");
      await ctx.success(await writeXp(ctx, user, ctx.options.getInteger("amount", true)));
    },
  },
  setlevel: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const user = ctx.options.getUser("member", true);
      ensure(!user.bot, "Bots don't earn XP.");
      const level = ctx.options.getInteger("level", true);
      // The member starts the level with 0 XP into it.
      await ctx.success(await writeXp(ctx, user, formula.totalXpForLevel(level)));
    },
  },
  removexp: {
    gate: "Manage Guild",
    run: async (interaction, ctx) => {
      const user = ctx.options.getUser("member", true);
      const current = store.getXp(ctx.guild.id, user.id);
      ensure(current > 0, `${user} has no XP.`);
      await ctx.success(await writeXp(ctx, user, current - ctx.options.getInteger("amount", true)));
    },
  },
};

module.exports = defineCommand({
  data,
  module: "levels",
  handlers,
  autocomplete: { update: rankChoices, remove: rankChoices },
});
