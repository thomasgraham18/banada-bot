/**
 * /invoke: the DM or channel message the punishment service (core/punish.js)
 * sends when someone is warned, muted, banned...
 *
 * Extra variables provided by the punishment service:
 *   {moderator} {moderator.name} {reason} {duration} {case} {punishment}
 */
const { SlashCommandBuilder } = require("discord.js");
const { defineCommand, script, ensure } = require("../../../core");
const store = require("../db");

const PUNISHMENTS = ["warn", "timeout", "mute", "imute", "rmute", "jail", "kick", "ban", "unban", "untimeout", "unjail"];
const TARGETS = { dm: "DM to the member", channel: "Message in the channel" };

/** Sample values for `view` (the real ones come from the punishment). */
const sampleVars = (interaction, punishment) => ({
  moderator: `<@${interaction.user.id}>`,
  "moderator.name": interaction.user.username,
  reason: "Example reason",
  duration: "1 hour",
  case: 123,
  punishment,
});

const VARIABLE_HELP = "Extra variables: `{moderator}` `{moderator.name}` `{reason}` `{duration}` `{case}` `{punishment}`";

const args = (s) =>
  s
    .addStringOption((o) => o.setName("punishment").setDescription("Punishment").setRequired(true)
      .addChoices(...PUNISHMENTS.map((p) => ({ name: p, value: p }))))
    .addStringOption((o) => o.setName("target").setDescription("DM or channel message").setRequired(true)
      .addChoices(...Object.entries(TARGETS).map(([value, name]) => ({ name, value }))));

const read = (ctx) => [ctx.options.getString("punishment", true), ctx.options.getString("target", true)];

module.exports = defineCommand({
  data: new SlashCommandBuilder()
    .setName("invoke")
    .setDescription("Custom messages sent when members are punished")
    .addSubcommand((s) => args(s.setName("set").setDescription("Set a punishment's DM or channel message")))
    .addSubcommand((s) => args(s.setName("clear").setDescription("Remove a punishment's DM or channel message")))
    .addSubcommand((s) => args(s.setName("view").setDescription("Preview a punishment's DM or channel message"))),
  handlers: {
    set: {
      gate: "Manage Guild",
      defer: false, // opens a modal
      async run(interaction, ctx) {
        const [punishment, target] = read(ctx);
        const result = await ctx.promptScript({
          title: `${punishment} ${target} message`,
          current: store.invoke.get(ctx.guild.id, punishment, target) ?? undefined,
        });
        if (!result) return;
        store.invoke.set(ctx.guild.id, punishment, target, result.script);
        return ctx.success(`Saved the **${punishment}** ${target === "dm" ? "DM" : "channel message"}. Preview it with \`/invoke view\`.\n${VARIABLE_HELP}`);
      },
    },
    clear: {
      gate: "Manage Guild",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const [punishment, target] = read(ctx);
        ensure(store.invoke.clear(ctx.guild.id, punishment, target), `There's no **${punishment}** ${target} message.`);
        return ctx.success(`Removed the **${punishment}** ${target} message.`);
      },
    },
    view: {
      gate: "Manage Guild",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const [punishment, target] = read(ctx);
        const stored = store.invoke.get(ctx.guild.id, punishment, target);
        ensure(stored, `There's no **${punishment}** ${target} message. Set one with \`/invoke set\`.`);
        const preview = script.render(stored, script.previewContext(interaction, sampleVars(interaction, punishment)));
        return ctx.reply({ ...preview, content: `**Preview** (${VARIABLE_HELP})\n${preview.content ?? ""}`.slice(0, 2000) });
      },
    },
  },
});

module.exports.PUNISHMENTS = PUNISHMENTS;
