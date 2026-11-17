/**
 * /reaction: automatic reactions (23 subcommands).
 *
 *   /reaction add|remove|removeall|clear|owner|list      react to messages containing a trigger
 *   /reaction previousreact add|remove|removeall|clear|owner|list
 *                                                         react to the message ABOVE (or replied to)
 *   /reaction messages set|remove|list                    react to every message in a channel
 *   /reaction noselfreact toggle|bypass|punishment|emoji|emojilist|exempt|exemptlist
 *   /reaction apply                                       react to one message now
 *
 * The listeners live in ../listeners.js.
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, ensure, guard, parse, ui, config, UserError } = require("../../../core");
const store = require("../db");
const matcher = require("../matcher");
const { triggerOption, code, showTrigger, emojiOption, emojiLabel } = require("../shared");

const EXPRESSIONS = "Manage Expressions";
const PUNISHMENTS = ["none", "warn", "timeout", "rmute", "kick"];
const REACT_PERMS = [P.ViewChannel, P.AddReactions, P.ReadMessageHistory];

// ---------------------------------------------------------------- builder

const emojiOpt = (name, description, required = true) => (o) =>
  o.setName(name).setDescription(description).setRequired(required).setMaxLength(100);
const triggerOpt = (autocomplete) => (o) =>
  o.setName("trigger").setDescription("The trigger word (`hi*` starts with, `*hi` ends with, `*hi*` contains)")
    .setRequired(true).setMaxLength(100).setAutocomplete(autocomplete);
const settingOpt = (o) => o.setName("setting").setDescription("Enable or disable").setRequired(true);

/** The six trigger subcommands, shared by /reaction and /reaction previousreact. */
function addTriggerSubcommands(target, noun) {
  return target
    .addSubcommand((s) => s.setName("add").setDescription(`Add a ${noun}`)
      .addStringOption(emojiOpt("emoji", "The emoji to react with"))
      .addStringOption(triggerOpt(false)))
    .addSubcommand((s) => s.setName("remove").setDescription(`Remove a ${noun}`)
      .addStringOption(triggerOpt(true))
      .addStringOption((o) => emojiOpt("emoji", "Only remove this emoji", false)(o).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("removeall").setDescription(`Remove every ${noun} for a specific word`).addStringOption(triggerOpt(true)))
    .addSubcommand((s) => s.setName("clear").setDescription(`Remove every ${noun} in this server`))
    .addSubcommand((s) => s.setName("owner").setDescription(`View who created a ${noun}`).addStringOption(triggerOpt(true)))
    .addSubcommand((s) => s.setName("list").setDescription(`View every ${noun} in this server`));
}

const data = new SlashCommandBuilder().setName("reaction").setDescription("Automatic reactions to messages");

data.addSubcommandGroup((g) =>
  g.setName("messages").setDescription("Auto-react to every message in a channel")
    .addSubcommand((s) => s.setName("set").setDescription("Auto-react to every message in a channel")
      .addChannelOption((o) => o.setName("channel").setDescription("The channel").setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption(emojiOpt("first", "First emoji"))
      .addStringOption(emojiOpt("second", "Second emoji", false))
      .addStringOption(emojiOpt("third", "Third emoji", false)))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove auto reactions from a channel")
      .addChannelOption((o) => o.setName("channel").setDescription("The channel").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("View auto reactions for every channel")));

data.addSubcommandGroup((g) =>
  addTriggerSubcommands(g.setName("previousreact").setDescription("React to the message above a trigger"), "previous reaction trigger"));

data.addSubcommandGroup((g) =>
  g.setName("noselfreact").setDescription("Stop members reacting to their own messages")
    .addSubcommand((s) => s.setName("toggle").setDescription("Enable or disable self-react monitoring").addBooleanOption(settingOpt))
    .addSubcommand((s) => s.setName("bypass").setDescription("Allow staff to bypass self-react monitoring").addBooleanOption(settingOpt))
    .addSubcommand((s) => s.setName("punishment").setDescription("Set the punishment for self-reacting")
      .addStringOption((o) => o.setName("punishment").setDescription("What happens to members who self-react").setRequired(true)
        .addChoices(
          { name: "None (just remove the reaction)", value: "none" },
          { name: "Warn", value: "warn" },
          { name: "Timeout (5 minutes)", value: "timeout" },
          { name: "Reaction mute (rmute role)", value: "rmute" },
          { name: "Kick", value: "kick" }
        )))
    .addSubcommand((s) => s.setName("emoji").setDescription("Add or remove an emoji from self-react monitoring").addStringOption(emojiOpt("emoji", "The emoji")))
    .addSubcommand((s) => s.setName("emojilist").setDescription("View a list of monitored self-react emojis"))
    .addSubcommand((s) => s.setName("exempt").setDescription("Exempt a member, channel or role from self-react punishments")
      .addChannelOption((o) => o.setName("channel").setDescription("Channel to exempt (or un-exempt)"))
      .addMentionableOption((o) => o.setName("member_or_role").setDescription("Member or role to exempt (or un-exempt)")))
    .addSubcommand((s) => s.setName("exemptlist").setDescription("View all exempted members, channels and roles")));

data.addSubcommand((s) => s.setName("apply").setDescription("Add reactions to a message")
  .addStringOption((o) => o.setName("message").setDescription("Message link or ID").setRequired(true))
  .addStringOption((o) => o.setName("emojis").setDescription("Emojis separated by spaces").setRequired(true)));
addTriggerSubcommands(data, "reaction trigger");

// ---------------------------------------------------------------- trigger handlers (normal + previous)

/** Handlers for add/remove/removeall/clear/owner/list of one kind ("normal" | "previous"). */
function triggerHandlers(kind) {
  const noun = kind === "previous" ? "previous reaction trigger" : "reaction trigger";
  const command = kind === "previous" ? "/reaction previousreact" : "/reaction";

  const rowsFor = (interaction) => {
    const trigger = triggerOption(interaction);
    const rows = store.listReactions(interaction.guildId, kind, trigger);
    ensure(rows.length, `There is no ${noun} for ${code(trigger)}. See \`${command} list\`.`);
    return { trigger, rows };
  };

  return {
    async add(interaction, ctx) {
      const emoji = emojiOption(interaction, "emoji", ctx.client);
      const trigger = triggerOption(interaction);
      const guildId = interaction.guildId;
      ensure(store.countReactions(guildId, kind) < store.LIMITS.reactionTriggers, `This server already has ${store.LIMITS.reactionTriggers} ${noun}s, the maximum.`);
      ensure(store.listReactions(guildId, kind, trigger).length < store.LIMITS.emojisPerTrigger, `${code(trigger)} already has ${store.LIMITS.emojisPerTrigger} emojis.`);
      ensure(store.addReaction(guildId, kind, trigger, emoji, ctx.user.id), `${code(trigger)} already reacts with ${emoji.text}.`);

      const where = kind === "previous" ? "the message above (or the one replied to)" : "messages";
      await ctx.success(`I'll react with ${emoji.text} to ${where} when someone says ${showTrigger(trigger, false)}.`);
    },

    async remove(interaction, ctx) {
      const { trigger, rows } = rowsFor(interaction);
      const typed = interaction.options.getString("emoji");
      let key;
      if (typed) key = parse.emojiKey(parse.emoji(typed));
      else {
        ensure(rows.length === 1, `${code(trigger)} has ${rows.length} emojis (${rows.map((r) => r.emoji).join(" ")}). Choose one with \`emoji\`, or use \`${command} removeall\`.`);
        key = rows[0].emoji_key;
      }
      const row = rows.find((r) => r.emoji_key === key);
      ensure(row, `${code(trigger)} doesn't react with ${typed}.`);
      store.removeReactions(interaction.guildId, kind, trigger, key);
      await ctx.success(`Removed ${row.emoji} from ${code(trigger)}.`);
    },

    async removeall(interaction, ctx) {
      const { trigger, rows } = rowsFor(interaction);
      if (!(await ui.confirm(interaction, `Remove all ${rows.length} emoji(s) from the ${noun} ${code(trigger)}?`))) return;
      store.removeReactions(interaction.guildId, kind, trigger);
      await ctx.success(`Removed the ${noun} ${code(trigger)}.`);
    },

    async clear(interaction, ctx) {
      const count = store.countReactions(interaction.guildId, kind);
      ensure(count, `This server has no ${noun}s.`);
      if (!(await ui.confirm(interaction, `Remove **every** ${noun} in this server (${count} emoji${count === 1 ? "" : "s"})?`))) return;
      store.removeReactions(interaction.guildId, kind);
      await ctx.success(`Cleared ${count} ${noun} emoji${count === 1 ? "" : "s"}.`);
    },

    async owner(interaction, ctx) {
      const { trigger, rows } = rowsFor(interaction);
      const lines = rows.map((r) => `${r.emoji} added by ${r.creator_id ? `<@${r.creator_id}>` : "unknown"} ${parse.timestamp(r.created_at)}`);
      await ctx.info(lines.join("\n"), `Who created ${trigger}`.slice(0, 256));
    },

    async list(interaction, ctx) {
      const grouped = new Map();
      for (const r of store.listReactions(interaction.guildId, kind)) {
        if (!grouped.has(r.trigger)) grouped.set(r.trigger, []);
        grouped.get(r.trigger).push(r.emoji);
      }
      const lines = [...grouped].map(([trigger, emojis]) => `${showTrigger(trigger, false)} → ${emojis.join(" ")}`);
      const title = kind === "previous" ? "Previous reaction triggers" : "Reaction triggers";
      await ui.paginate(interaction, ui.listPages(ctx.client, title, lines, { empty: `No ${noun}s yet. Add one with \`${command} add\`.` }));
    },
  };
}

/** Autocomplete for the trigger / emoji options of one kind. */
const triggerAutocomplete = (kind) => (interaction, ctx) => {
  if (ctx.focused.name === "emoji") {
    let trigger;
    try {
      trigger = matcher.cleanTrigger(interaction.options.getString("trigger") ?? "");
    } catch {
      return [];
    }
    return store.listReactions(interaction.guildId, kind, trigger).map((r) => ({ name: emojiLabel(r.emoji), value: r.emoji }));
  }
  return store.reactionTriggers(interaction.guildId, kind);
};

// ---------------------------------------------------------------- messages

async function messagesSet(interaction, ctx) {
  const channel = interaction.options.getChannel("channel", true);
  guard.assertBotPermissions(channel, REACT_PERMS);
  const emojis = ["first", "second", "third"]
    .filter((name) => interaction.options.getString(name))
    .map((name) => emojiOption(interaction, name, ctx.client));
  const unique = [...new Map(emojis.map((e) => [e.key, e])).values()];
  store.setChannelReactions(interaction.guildId, channel.id, unique);
  await ctx.success(`I'll react with ${unique.map((e) => e.text).join(" ")} to every message in ${channel}.`);
}

async function messagesRemove(interaction, ctx) {
  const channel = interaction.options.getChannel("channel", true);
  ensure(store.removeChannelReactions(interaction.guildId, channel.id), `${channel} has no auto reactions.`);
  await ctx.success(`Removed the auto reactions from ${channel}.`);
}

async function messagesList(interaction, ctx) {
  const lines = store.listChannelReactions(interaction.guildId).map((r) => `<#${r.channelId}> → ${r.emojis.map((e) => e.text).join(" ")}`);
  await ui.paginate(interaction, ui.listPages(ctx.client, "Channel auto reactions", lines, { empty: "No channel has auto reactions. Use `/reaction messages set`." }));
}

// ---------------------------------------------------------------- noselfreact

const onOff = (b) => (b ? "**enabled**" : "**disabled**");

async function nsrToggle(interaction, ctx) {
  const enabled = interaction.options.getBoolean("setting", true);
  const cfg = store.setNoSelfReact(interaction.guildId, { enabled });
  let note = "";
  if (enabled && !interaction.guild.members.me.permissions.has(P.ManageMessages))
    note = "\n⚠️ I need **Manage Messages** to remove self-reactions.";
  await ctx.success(`Self-react monitoring is ${onOff(enabled)}. Punishment: **${cfg.punishment}**.${note}`);
}

async function nsrBypass(interaction, ctx) {
  const bypass = interaction.options.getBoolean("setting", true);
  store.setNoSelfReact(interaction.guildId, { bypass_staff: bypass });
  await ctx.success(bypass ? "Staff can now react to their own messages." : "Staff are now monitored like everyone else.");
}

async function nsrPunishment(interaction, ctx) {
  const punishment = interaction.options.getString("punishment", true);
  ensure(PUNISHMENTS.includes(punishment), "Unknown punishment.");
  store.setNoSelfReact(interaction.guildId, { punishment });
  let note = "";
  if (punishment === "rmute" && !config.get(interaction.guildId, config.KEYS.RMUTED_ROLE))
    note = "\n⚠️ No reaction-muted role is set yet (see `/settings`), so this punishment will fail until one is.";
  await ctx.success(`Self-reacting now results in: **${punishment}** (the reaction is always removed).${note}`);
}

async function nsrEmoji(interaction, ctx) {
  const emoji = emojiOption(interaction, "emoji"); // no client: any emoji can be monitored
  const added = store.toggleNoSelfReactEmoji(interaction.guildId, emoji.key, emoji.text);
  const left = store.listNoSelfReactEmojis(interaction.guildId).length;
  await ctx.success(added ? `Now monitoring ${emoji.text}.` : `Stopped monitoring ${emoji.text}.${left ? "" : " The list is empty, so **every** emoji is monitored."}`);
}

async function nsrEmojiList(interaction, ctx) {
  const rows = store.listNoSelfReactEmojis(interaction.guildId);
  await ui.paginate(interaction, ui.listPages(ctx.client, "Monitored self-react emojis", rows.map((r) => r.emoji), {
    perPage: 25,
    empty: "No emojis listed, so **every** emoji is monitored.",
  }));
}

async function nsrExempt(interaction, ctx) {
  const channel = interaction.options.getChannel("channel");
  const option = interaction.options.get("member_or_role");
  ensure(channel || option, "Give a `channel`, a `member_or_role`, or both.");

  const targets = [];
  if (channel) targets.push({ id: channel.id, kind: "channel", label: `${channel}` });
  if (option?.role) targets.push({ id: option.role.id, kind: "role", label: `<@&${option.role.id}>` });
  else if (option?.user) targets.push({ id: option.user.id, kind: "member", label: `<@${option.user.id}>` });
  if (option?.role) ensure(option.role.id !== interaction.guildId, "Exempting @everyone would turn monitoring off; use `/reaction noselfreact toggle` instead.");

  const lines = targets.map((t) => `${t.label}: ${store.toggleNoSelfReactExempt(interaction.guildId, t.id, t.kind) ? "now exempt" : "no longer exempt"}`);
  await ctx.success(lines.join("\n"));
}

async function nsrExemptList(interaction, ctx) {
  const show = { member: (id) => `Member: <@${id}>`, role: (id) => `Role: <@&${id}>`, channel: (id) => `Channel: <#${id}>` };
  const lines = store.listNoSelfReactExempt(interaction.guildId).map((r) => show[r.kind](r.target_id));
  await ui.paginate(interaction, ui.listPages(ctx.client, "Self-react exemptions", lines, { empty: "Nothing is exempt." }));
}

// ---------------------------------------------------------------- apply

async function apply(interaction, ctx) {
  const message = await parse.fetchMessage(interaction, interaction.options.getString("message", true));
  const emojis = parse.emojis(interaction.options.getString("emojis", true), ctx.client);
  ensure(emojis.length, "Give at least one emoji.");
  ensure(emojis.length <= store.LIMITS.reactionsPerMessage, `A message can have at most ${store.LIMITS.reactionsPerMessage} different reactions.`);
  guard.assertBotPermissions(message.channel, REACT_PERMS);

  const failed = [];
  for (const emoji of emojis) {
    try {
      await message.react(emoji.identifier);
    } catch (err) {
      if (err.code === 30010) throw new UserError("That message already has the maximum number of reactions.");
      failed.push(emoji.text);
    }
  }
  const done = emojis.length - failed.length;
  await ctx.success(`Added ${done} reaction${done === 1 ? "" : "s"} to [the message](${message.url}).${failed.length ? `\nCouldn't add: ${failed.join(" ")}` : ""}`);
}

// ---------------------------------------------------------------- command

const normal = triggerHandlers("normal");
const previous = triggerHandlers("previous");
const ADMIN = "Administrator";

module.exports = defineCommand({
  data,
  module: "reaction",
  handlers: {
    "messages set": { gate: EXPRESSIONS, run: messagesSet },
    "messages remove": { gate: EXPRESSIONS, run: messagesRemove },
    "messages list": { gate: EXPRESSIONS, run: messagesList },
    "previousreact add": { gate: EXPRESSIONS, run: previous.add },
    "previousreact remove": { gate: EXPRESSIONS, run: previous.remove },
    "previousreact removeall": { gate: EXPRESSIONS, run: previous.removeall },
    "previousreact clear": { gate: EXPRESSIONS, run: previous.clear },
    "previousreact owner": { gate: EXPRESSIONS, run: previous.owner },
    "previousreact list": { gate: EXPRESSIONS, run: previous.list },
    "noselfreact toggle": { gate: ADMIN, run: nsrToggle },
    "noselfreact bypass": { gate: "Server Owner", run: nsrBypass },
    "noselfreact punishment": { gate: ADMIN, run: nsrPunishment },
    "noselfreact emoji": { gate: ADMIN, run: nsrEmoji },
    "noselfreact emojilist": { gate: ADMIN, run: nsrEmojiList },
    "noselfreact exempt": { gate: ADMIN, run: nsrExempt },
    "noselfreact exemptlist": { gate: ADMIN, run: nsrExemptList },
    apply: { gate: "Manage Messages", defer: "ephemeral", run: apply },
    add: { gate: EXPRESSIONS, run: normal.add },
    remove: { gate: EXPRESSIONS, run: normal.remove },
    removeall: { gate: EXPRESSIONS, run: normal.removeall },
    clear: { gate: EXPRESSIONS, run: normal.clear },
    owner: { gate: EXPRESSIONS, run: normal.owner },
    list: { gate: EXPRESSIONS, run: normal.list },
  },
  autocomplete: {
    remove: triggerAutocomplete("normal"),
    removeall: triggerAutocomplete("normal"),
    owner: triggerAutocomplete("normal"),
    "previousreact remove": triggerAutocomplete("previous"),
    "previousreact removeall": triggerAutocomplete("previous"),
    "previousreact owner": triggerAutocomplete("previous"),
  },
});
