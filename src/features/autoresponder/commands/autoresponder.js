/**
 * /autoresponder: reply to messages that match a trigger (13 subcommands).
 *
 *   /autoresponder add|update|remove|reset
 *   /autoresponder list all|tickets
 *   /autoresponder role add|remove|addlist|removelist
 *   /autoresponder exclusive add|remove|list
 *
 * The reply is a core message script collected through a modal. The
 * listener lives in ../listeners.js; matching rules in ../matcher.js.
 */
const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { defineCommand, ensure, guard, script, ui } = require("../../../core");
const store = require("../db");
const { triggerOption, code, showTrigger, MATCHING_HELP } = require("../shared");

const GATE = "Manage Channels";

// ---------------------------------------------------------------- builder

const triggerOpt = (autocomplete, description = "The trigger word or phrase") => (o) =>
  o.setName("trigger").setDescription(description).setRequired(true).setMaxLength(100).setAutocomplete(autocomplete);

/** The shared options of add / update. */
const responderOptions = (s, autocomplete) =>
  s
    .addStringOption(triggerOpt(autocomplete, "Trigger word or phrase (`hi*` starts with, `*hi` ends with, `*hi*` contains)"))
    .addIntegerOption((o) => o.setName("self_destruct").setDescription("Delete the reply after this many seconds (0 = never)").setMinValue(0).setMaxValue(3600))
    .addBooleanOption((o) => o.setName("strict").setDescription("Only fire when the whole message is the trigger"))
    .addBooleanOption((o) => o.setName("ignore_command_check").setDescription("Also fire on messages that look like bot commands (!cmd, ?cmd…)"))
    .addBooleanOption((o) => o.setName("delete").setDescription("Delete the message that triggered it"))
    .addBooleanOption((o) => o.setName("reply").setDescription("Send the response as a reply"))
    .addBooleanOption((o) => o.setName("ticket_form").setDescription("Mark this as a ticket auto-reply"));

const data = new SlashCommandBuilder()
  .setName("autoresponder")
  .setDescription("Automatic replies to trigger words")
  .addSubcommandGroup((g) =>
    g.setName("list").setDescription("View auto-reply triggers")
      .addSubcommand((s) => s.setName("all").setDescription("View auto-reply triggers in this server"))
      .addSubcommand((s) => s.setName("tickets").setDescription("View ticket auto-reply triggers in this server")))
  .addSubcommandGroup((g) =>
    g.setName("role").setDescription("Roles given or removed when a trigger matches")
      .addSubcommand((s) => s.setName("add").setDescription("Enable or disable giving a role when a trigger matches")
        .addRoleOption((o) => o.setName("role").setDescription("The role to give").setRequired(true))
        .addStringOption(triggerOpt(true))
        .addBooleanOption((o) => o.setName("setting").setDescription("Enable or disable").setRequired(true)))
      .addSubcommand((s) => s.setName("remove").setDescription("Enable or disable removing a role when a trigger matches")
        .addRoleOption((o) => o.setName("role").setDescription("The role to remove").setRequired(true))
        .addStringOption(triggerOpt(true))
        .addBooleanOption((o) => o.setName("setting").setDescription("Enable or disable").setRequired(true)))
      .addSubcommand((s) => s.setName("addlist").setDescription("View roles given upon messages matching a trigger").addStringOption(triggerOpt(true)))
      .addSubcommand((s) => s.setName("removelist").setDescription("View roles removed upon messages matching a trigger").addStringOption(triggerOpt(true))))
  .addSubcommandGroup((g) =>
    g.setName("exclusive").setDescription("Limit triggers to roles or channels")
      .addSubcommand((s) => s.setName("add").setDescription("Limit a trigger to a role or channel")
        .addStringOption(triggerOpt(true))
        .addRoleOption((o) => o.setName("role").setDescription("Only members with this role trigger it"))
        .addChannelOption((o) => o.setName("channel").setDescription("Only fires in this channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum)))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove a role or channel's exclusive access to a trigger")
        .addStringOption(triggerOpt(true))
        .addRoleOption((o) => o.setName("role").setDescription("The role to remove"))
        .addChannelOption((o) => o.setName("channel").setDescription("The channel to remove")))
      .addSubcommand((s) => s.setName("list").setDescription("View the roles and channels a trigger is limited to").addStringOption(triggerOpt(true))))
  .addSubcommand((s) => responderOptions(s.setName("add").setDescription("Create a reply for a trigger word"), false))
  .addSubcommand((s) => responderOptions(s.setName("update").setDescription("Update a reply for a trigger word"), true))
  .addSubcommand((s) => s.setName("remove").setDescription("Remove a reply for a trigger word").addStringOption(triggerOpt(true)))
  .addSubcommand((s) => s.setName("reset").setDescription("Remove every auto response"));

// ---------------------------------------------------------------- helpers

/** The stored autoresponder for the trigger option, or a UserError. */
function existing(interaction) {
  const trigger = triggerOption(interaction);
  const row = store.getAutoresponder(interaction.guildId, trigger);
  ensure(row, `There is no autoresponder for ${code(trigger)}. See \`/autoresponder list all\`.`);
  return row;
}

/** "reply, deletes trigger, self-destructs after 10s" */
function flags(row) {
  const out = [];
  if (row.reply) out.push("reply");
  if (row.delete_message) out.push("deletes trigger");
  if (row.self_destruct) out.push(`self-destructs after ${row.self_destruct}s`);
  if (row.ignore_command_check) out.push("fires on commands");
  if (row.ticket_form) out.push("ticket");
  return out.join(", ");
}

const line = (row) => {
  const extra = flags(row);
  return `${showTrigger(row.trigger, row.strict)}${extra ? ` · ${extra}` : ""}`;
};

/** Options given on add/update, merged over `base`. */
function readOptions(interaction, base = {}) {
  const o = interaction.options;
  const pick = (name, current) => o.get(name)?.value ?? current;
  return {
    self_destruct: pick("self_destruct", base.self_destruct) || null, // 0 clears it
    strict: pick("strict", Boolean(base.strict)),
    ignore_command_check: pick("ignore_command_check", Boolean(base.ignore_command_check)),
    delete_message: pick("delete", Boolean(base.delete_message)),
    reply: pick("reply", Boolean(base.reply)),
    ticket_form: pick("ticket_form", Boolean(base.ticket_form)),
  };
}

const listTriggers = (guildId) => store.listAutoresponders(guildId).map((r) => r.trigger);

// ---------------------------------------------------------------- handlers

async function add(interaction, ctx) {
  const trigger = triggerOption(interaction);
  const guildId = interaction.guildId;
  ensure(!store.getAutoresponder(guildId, trigger), `${code(trigger)} already has a reply. Use \`/autoresponder update\` to change it.`);
  ensure(store.countAutoresponders(guildId) < store.LIMITS.autoresponders, `This server already has ${store.LIMITS.autoresponders} autoresponders, the maximum.`);
  const settings = readOptions(interaction);

  const result = await ctx.promptScript({ title: `Reply for "${trigger}"`.slice(0, 45) });
  if (!result) return;
  store.saveAutoresponder(guildId, { trigger, script: script.validate(result.script), creator_id: ctx.user.id, ...settings });

  const extra = flags(settings);
  await ctx.success(`Added an autoresponder for ${showTrigger(trigger, settings.strict)}${extra ? ` (${extra})` : ""}.\n-# ${MATCHING_HELP} Extra variable: \`{trigger}\`.`);
}

async function update(interaction, ctx) {
  const row = existing(interaction);
  const settings = readOptions(interaction, row);

  const result = await ctx.promptScript({ title: `Reply for "${row.trigger}"`.slice(0, 45), current: row.script });
  if (!result) return;
  store.saveAutoresponder(interaction.guildId, { ...row, ...settings, script: script.validate(result.script) });

  const extra = flags(settings);
  await ctx.success(`Updated the autoresponder for ${showTrigger(row.trigger, settings.strict)}${extra ? ` (${extra})` : ""}.`);
}

async function remove(interaction, ctx) {
  const row = existing(interaction);
  store.removeAutoresponder(interaction.guildId, row.trigger);
  await ctx.success(`Removed the autoresponder for ${code(row.trigger)}.`);
}

async function reset(interaction, ctx) {
  const count = store.countAutoresponders(interaction.guildId);
  ensure(count, "This server has no autoresponders.");
  if (!(await ui.confirm(interaction, `Remove **all ${count}** autoresponders, with their roles and exclusive settings?`))) return;
  store.resetAutoresponders(interaction.guildId);
  await ctx.success(`Removed ${count} autoresponder${count === 1 ? "" : "s"}.`);
}

const list = (ticketsOnly) => async (interaction, ctx) => {
  const rows = store.listAutoresponders(interaction.guildId, { ticketsOnly });
  const title = ticketsOnly ? "Ticket autoresponders" : "Autoresponders";
  const pages = ui.listPages(ctx.client, title, rows.map(line), {
    empty: ticketsOnly ? "No autoresponder is marked as a ticket form." : "No autoresponders yet. Add one with `/autoresponder add`.",
  });
  await ui.paginate(interaction, pages);
};

/** role add / role remove: setting=true links the role, false unlinks it. */
const roleToggle = (action) => async (interaction, ctx) => {
  const row = existing(interaction);
  const role = interaction.options.getRole("role", true);
  const enable = interaction.options.getBoolean("setting", true);
  if (enable) guard.assertManageableRole(ctx.member, role);

  const changed = store.setTriggerRole(interaction.guildId, row.trigger, role.id, action, enable);
  const verb = action === "add" ? "given" : "removed";
  if (!changed)
    return ctx.info(`${role} ${enable ? "is already" : "was not"} ${verb} when ${code(row.trigger)} matches.`);
  await ctx.success(enable ? `${role} will be ${verb} when ${code(row.trigger)} matches.` : `${role} will no longer be ${verb} when ${code(row.trigger)} matches.`);
};

const roleList = (action) => async (interaction, ctx) => {
  const row = existing(interaction);
  const ids = store.listTriggerRoles(interaction.guildId, row.trigger, action);
  const title = `Roles ${action === "add" ? "given" : "removed"} by ${row.trigger}`.slice(0, 256);
  await ui.paginate(interaction, ui.listPages(ctx.client, title, ids.map((id) => `<@&${id}>`), { empty: "No roles are linked to this trigger." }));
};

/** exclusive add / remove: at least one of role / channel. */
const exclusiveToggle = (enable) => async (interaction, ctx) => {
  const row = existing(interaction);
  const role = interaction.options.getRole("role");
  const channel = interaction.options.getChannel("channel");
  ensure(role || channel, "Give a `role`, a `channel`, or both.");

  const results = [];
  for (const [target, kind] of [[role, "role"], [channel, "channel"]]) {
    if (!target) continue;
    const changed = store.setExclusive(interaction.guildId, row.trigger, target.id, kind, enable);
    results.push(`${target}: ${changed ? (enable ? "added" : "removed") : enable ? "already exclusive" : "was not exclusive"}`);
  }
  await ctx.success(`Exclusive access for ${code(row.trigger)}\n${results.join("\n")}`);
};

async function exclusiveList(interaction, ctx) {
  const row = existing(interaction);
  const rows = store.listExclusive(interaction.guildId, row.trigger);
  const lines = rows.map((r) => (r.kind === "role" ? `Role: <@&${r.target_id}>` : `Channel: <#${r.target_id}>`));
  await ui.paginate(interaction, ui.listPages(ctx.client, `Exclusive access for ${row.trigger}`.slice(0, 256), lines, {
    empty: "Not limited: this trigger fires for everyone in every channel.",
    footer: "With roles set, members need one of them. With channels set, it only fires there.",
  }));
}

// ---------------------------------------------------------------- command

const triggers = (interaction) => listTriggers(interaction.guildId);

module.exports = defineCommand({
  data,
  module: "autoresponder",
  handlers: {
    "list all": { gate: GATE, run: list(false) },
    "list tickets": { gate: GATE, run: list(true) },
    "role add": { gate: GATE, run: roleToggle("add") },
    "role remove": { gate: GATE, run: roleToggle("remove") },
    "role addlist": { gate: GATE, run: roleList("add") },
    "role removelist": { gate: GATE, run: roleList("remove") },
    "exclusive add": { gate: GATE, run: exclusiveToggle(true) },
    "exclusive remove": { gate: GATE, run: exclusiveToggle(false) },
    "exclusive list": { gate: GATE, run: exclusiveList },
    add: { gate: GATE, defer: false, run: add },
    update: { gate: GATE, defer: false, run: update },
    remove: { gate: GATE, run: remove },
    reset: { gate: GATE, run: reset },
  },
  autocomplete: {
    update: triggers,
    remove: triggers,
    "role add": triggers,
    "role remove": triggers,
    "role addlist": triggers,
    "role removelist": triggers,
    "exclusive add": triggers,
    "exclusive remove": triggers,
    "exclusive list": triggers,
  },
});
