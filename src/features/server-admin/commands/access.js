/**
 * /access: disable commands, modules (top-level commands + their listeners)
 * and bot events per channel/member, plus fake permissions.
 *
 * Every disable/enable goes through core.access (it owns the tables and the
 * caches the router and listeners read). Fake permissions are written here
 * and then core.access.invalidate() refreshes the guard's cache.
 */
const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { defineCommand, access, guard, ui, commandPaths, ensure } = require("../../../core");
const store = require("../db");

/** Channels a command/module/event can be disabled in (threads inherit their parent). */
const SCOPE_CHANNELS = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice,
  ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread,
];

/** Commands that would lock admins out of undoing the change if disabled. */
const PROTECTED = new Set(["access"]);

// ---------------------------------------------------------------- name lists

/** "levels", "levels rank", "levels reset", ... for every registered command. */
function commandNames(client) {
  const names = [];
  for (const command of client.commands.values()) {
    const json = command.data.toJSON();
    names.push(json.name);
    for (const p of commandPaths(json)) if (p) names.push(`${json.name} ${p}`);
  }
  return [...new Set(names)].sort();
}

/** Module names = each command's `module` (defineCommand) or its name (old music commands). */
const moduleNames = (client) =>
  [...new Set([...client.commands.values()].map((c) => c.module ?? c.data.name))].sort();

const scopeLabel = (channelId, memberId) =>
  memberId ? `for <@${memberId}>` : channelId ? `in <#${channelId}>` : "everywhere";

/** Reads + normalises the `command` option and checks it exists. */
function commandOption(ctx) {
  const name = ctx.options.getString("command", true).trim().toLowerCase().replace(/^\//, "").replace(/\s+/g, " ");
  ensure(commandNames(ctx.client).includes(name), `\`/${name}\` isn't a command of this bot. Pick one from the list.`);
  ensure(!PROTECTED.has(name.split(" ")[0]), `\`/${name}\` can't be disabled, or nobody could re-enable things.`);
  return name;
}

function moduleOption(ctx) {
  const name = ctx.options.getString("module", true).trim().toLowerCase();
  ensure(moduleNames(ctx.client).includes(name), `**${name}** isn't a module of this bot. Pick one from the list.`);
  ensure(!PROTECTED.has(name), `The **${name}** module can't be disabled, or nobody could re-enable things.`);
  return name;
}

// ---------------------------------------------------------------- builder

const settingOption = (s) => s.addBooleanOption((o) => o.setName("setting").setDescription("True = enabled, false = disabled").setRequired(true));
const commandArg = (s) => s.addStringOption((o) => o.setName("command").setDescription("Command, e.g. levels or levels rank").setRequired(true).setAutocomplete(true));
const moduleArg = (s) => s.addStringOption((o) => o.setName("module").setDescription("Module (a top-level command)").setRequired(true).setAutocomplete(true));
const eventArg = (s) => s.addStringOption((o) => o.setName("event").setDescription("Bot event").setRequired(true)
  .addChoices(...access.EVENTS.map((e) => ({ name: e, value: e }))));
const channelArg = (s, description) => s.addChannelOption((o) => o.setName("channel").setDescription(description).addChannelTypes(...SCOPE_CHANNELS));
const roleArg = (s, required = true) => s.addRoleOption((o) => o.setName("role").setDescription("The role").setRequired(required));
const permissionArg = (s) => s.addStringOption((o) => o.setName("permissions").setDescription("Permission to fake").setRequired(true)
  .addChoices(...Object.keys(guard.FAKEABLE).map((k) => ({ name: k, value: k }))));

const data = new SlashCommandBuilder()
  .setName("access")
  .setDescription("Control where commands, modules and bot events work, and fake permissions")
  .addSubcommandGroup((g) => g.setName("command").setDescription("Disable commands")
    .addSubcommand((s) => {
      settingOption(commandArg(s.setName("set").setDescription("Disable or enable a command in a channel or for a member")));
      channelArg(s, "Channel (default: this one)");
      return s.addUserOption((o) => o.setName("member").setDescription("Member (instead of a channel)"));
    })
    .addSubcommand((s) => settingOption(commandArg(s.setName("all").setDescription("Disable or enable a command in every text channel"))))
    .addSubcommand((s) => s.setName("list").setDescription("View every disabled command")))
  .addSubcommandGroup((g) => g.setName("module").setDescription("Disable modules (a command and its automatic features)")
    .addSubcommand((s) => channelArg(settingOption(moduleArg(s.setName("set").setDescription("Disable or enable a module in a channel"))), "Channel (default: this one)"))
    .addSubcommand((s) => settingOption(moduleArg(s.setName("all").setDescription("Disable or enable a module in every text channel"))))
    .addSubcommand((s) => s.setName("list").setDescription("View every disabled module")))
  .addSubcommandGroup((g) => g.setName("event").setDescription("Disable automatic bot events")
    .addSubcommand((s) => channelArg(settingOption(eventArg(s.setName("set").setDescription("Disable or enable a bot event in a channel or thread"))), "Channel or thread (default: this one)"))
    .addSubcommand((s) => settingOption(eventArg(s.setName("all").setDescription("Disable or enable a bot event in every text channel"))))
    .addSubcommand((s) => s.setName("list").setDescription("View every disabled bot event")))
  .addSubcommandGroup((g) => g.setName("fakepermissions").setDescription("Bot-only permissions granted to roles")
    .addSubcommand((s) => permissionArg(roleArg(s.setName("add").setDescription("Grant a role fake permissions"))))
    .addSubcommand((s) => permissionArg(roleArg(s.setName("remove").setDescription("Remove fake permissions from a role"))))
    .addSubcommand((s) => roleArg(s.setName("list").setDescription("View every fake permission"), false))
    .addSubcommand((s) => s.setName("reset").setDescription("Remove every fake permission in the server")))
  .addSubcommand((s) => s.setName("copy").setDescription("Copy disabled commands, modules, events and filters to another channel")
    .addChannelOption((o) => o.setName("old_channel").setDescription("Copy from").setRequired(true).addChannelTypes(...SCOPE_CHANNELS))
    .addChannelOption((o) => o.setName("new_channel").setDescription("Copy to").setRequired(true).addChannelTypes(...SCOPE_CHANNELS)));

// ---------------------------------------------------------------- handlers

const GATE = "Manage Channels";

/** Removes every row (any scope) for `name` via the given lister/setter. */
function enableEverywhere(rows, unset) {
  for (const row of rows) unset(row);
  return rows.length;
}

module.exports = defineCommand({
  data,
  handlers: {
    "command set": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const command = commandOption(ctx);
        const enabled = ctx.options.getBoolean("setting", true);
        const member = ctx.options.getUser("member");
        const channel = ctx.options.getChannel("channel");
        ensure(!(member && channel), "Pick a channel **or** a member, not both. A member is blocked in every channel.");
        const scope = member ? { memberId: member.id } : { channelId: (channel ?? ctx.channel).id };
        access.setCommand(ctx.guild.id, command, !enabled, scope);
        return ctx.success(`\`/${command}\` is now **${enabled ? "enabled" : "disabled"}** ${scopeLabel(scope.channelId, scope.memberId)}.`);
      },
    },
    "command all": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const command = commandOption(ctx);
        const enabled = ctx.options.getBoolean("setting", true);
        if (!enabled) {
          access.setCommand(ctx.guild.id, command, true);
          return ctx.success(`\`/${command}\` is now **disabled** everywhere.`);
        }
        const n = enableEverywhere(access.listCommands(ctx.guild.id).filter((r) => r.command === command),
          (r) => access.setCommand(ctx.guild.id, command, false, { channelId: r.channel_id, memberId: r.member_id }));
        return ctx.success(`\`/${command}\` is now **enabled** everywhere (${n} rule${n === 1 ? "" : "s"} removed).`);
      },
    },
    "command list": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const lines = access.listCommands(ctx.guild.id).map((r) => `\`/${r.command}\` ${scopeLabel(r.channel_id, r.member_id)}`);
        return ui.paginate(interaction, ui.listPages(ctx.client, "Disabled commands", lines, { empty: "No commands are disabled." }));
      },
    },

    "module set": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const mod = moduleOption(ctx);
        const enabled = ctx.options.getBoolean("setting", true);
        const channel = ctx.options.getChannel("channel") ?? ctx.channel;
        access.setModule(ctx.guild.id, mod, !enabled, channel.id);
        return ctx.success(`The **${mod}** module is now **${enabled ? "enabled" : "disabled"}** in ${channel}.`);
      },
    },
    "module all": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const mod = moduleOption(ctx);
        const enabled = ctx.options.getBoolean("setting", true);
        if (!enabled) {
          access.setModule(ctx.guild.id, mod, true);
          return ctx.success(`The **${mod}** module is now **disabled** everywhere.`);
        }
        const n = enableEverywhere(access.listModules(ctx.guild.id).filter((r) => r.module === mod),
          (r) => access.setModule(ctx.guild.id, mod, false, r.channel_id));
        return ctx.success(`The **${mod}** module is now **enabled** everywhere (${n} rule${n === 1 ? "" : "s"} removed).`);
      },
    },
    "module list": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const lines = access.listModules(ctx.guild.id).map((r) => `**${r.module}** ${scopeLabel(r.channel_id)}`);
        return ui.paginate(interaction, ui.listPages(ctx.client, "Disabled modules", lines, { empty: "No modules are disabled." }));
      },
    },

    "event set": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const event = ctx.options.getString("event", true);
        const enabled = ctx.options.getBoolean("setting", true);
        const channel = ctx.options.getChannel("channel") ?? ctx.channel;
        access.setEvent(ctx.guild.id, event, !enabled, channel.id);
        return ctx.success(`The **${event}** event is now **${enabled ? "enabled" : "disabled"}** in ${channel}.`);
      },
    },
    "event all": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const event = ctx.options.getString("event", true);
        const enabled = ctx.options.getBoolean("setting", true);
        if (!enabled) {
          access.setEvent(ctx.guild.id, event, true);
          return ctx.success(`The **${event}** event is now **disabled** everywhere.`);
        }
        const n = enableEverywhere(access.listEvents(ctx.guild.id).filter((r) => r.event === event),
          (r) => access.setEvent(ctx.guild.id, event, false, r.channel_id));
        return ctx.success(`The **${event}** event is now **enabled** everywhere (${n} rule${n === 1 ? "" : "s"} removed).`);
      },
    },
    "event list": {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const lines = access.listEvents(ctx.guild.id).map((r) => `**${r.event}** ${scopeLabel(r.channel_id)}`);
        return ui.paginate(interaction, ui.listPages(ctx.client, "Disabled bot events", lines, { empty: "No bot events are disabled." }));
      },
    },

    "fakepermissions add": {
      gate: "Server Owner",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const role = ctx.options.getRole("role", true);
        ensure(role.id !== ctx.guild.id, "Fake permissions on @everyone would give them to every member. Use a role.");
        const choice = ctx.options.getString("permissions", true);
        const flag = guard.FAKEABLE[choice];
        ensure(flag, "Unknown permission.");
        const added = store.fake.add(ctx.guild.id, role.id, [flag]);
        if (!added) return ctx.info(`${role} already has fake **${choice}**.`);
        return ctx.success(`${role} now has fake **${choice}** (only for this bot's commands).`);
      },
    },
    "fakepermissions remove": {
      gate: "Server Owner",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const role = ctx.options.getRole("role", true);
        const choice = ctx.options.getString("permissions", true);
        const removed = store.fake.remove(ctx.guild.id, role.id, [guard.FAKEABLE[choice]]);
        ensure(removed, `${role} doesn't have fake **${choice}**.`);
        return ctx.success(`Removed fake **${choice}** from ${role}.`);
      },
    },
    "fakepermissions list": {
      gate: "Server Owner",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const role = ctx.options.getRole("role");
        const byRole = new Map();
        const nameOf = Object.fromEntries(Object.entries(guard.FAKEABLE).map(([k, v]) => [v, k]));
        for (const r of store.fake.list(ctx.guild.id, role?.id)) {
          if (!byRole.has(r.role_id)) byRole.set(r.role_id, []);
          byRole.get(r.role_id).push(nameOf[r.permission] ?? r.permission);
        }
        const lines = [...byRole].map(([id, perms]) => `<@&${id}>: ${perms.map((p) => `\`${p}\``).join(", ")}`);
        return ui.paginate(interaction, ui.listPages(ctx.client, "Fake permissions", lines, { empty: role ? `${role} has no fake permissions.` : "No fake permissions." }));
      },
    },
    "fakepermissions reset": {
      gate: "Server Owner",
      defer: "ephemeral",
      async run(interaction, ctx) {
        ensure(store.fake.list(ctx.guild.id).length, "There are no fake permissions to remove.");
        if (!(await ui.confirm(interaction, "Remove **every** fake permission in this server?"))) return;
        const n = store.fake.reset(ctx.guild.id);
        return ctx.success(`Removed ${n} fake permission${n === 1 ? "" : "s"}.`);
      },
    },

    copy: {
      gate: GATE,
      defer: "ephemeral",
      async run(interaction, ctx) {
        const from = ctx.options.getChannel("old_channel", true);
        const to = ctx.options.getChannel("new_channel", true);
        ensure(from.id !== to.id, "Pick two different channels.");
        access.copyChannel(ctx.guild.id, from.id, to.id);
        // Per-channel filter settings belong to the filter package (WP2), if installed.
        const filter = require("../../../handlers/features").api("filter");
        let filterNote = "";
        if (typeof filter?.copyChannel === "function") {
          await filter.copyChannel(ctx.guild.id, from.id, to.id);
          filterNote = ", filter settings";
        }
        return ctx.success(`Copied disabled commands, modules, events${filterNote} from ${from} to ${to}.`);
      },
    },
  },
  autocomplete: {
    "command set": (interaction) => commandNames(interaction.client),
    "command all": (interaction) => commandNames(interaction.client),
    "module set": (interaction) => moduleNames(interaction.client),
    "module all": (interaction) => moduleNames(interaction.client),
  },
});
