/**
 * /config welcome | goodbye | boosts  add / remove / view / list.
 * The three groups behave the same; only the stored `kind` differs.
 */
const { MessageFlags, PermissionFlagsBits: P } = require("discord.js");
const { script, ui, guard, UserError } = require("../../../core");
const store = require("../db");
const { withPing, allowedMentions, JOIN_VARIABLES } = require("../lib");

const LABEL = { welcome: "Welcome", goodbye: "Goodbye", boost: "Boost" };
const DEFAULTS = {
  welcome: "Welcome {user.mention} to **{guild.name}**! You are our {guild.count.ordinal} member.",
  goodbye: "**{user.name}** left {guild.name}. We now have {guild.count} members.",
  boost: "Thank you {user.mention} for boosting **{guild.name}**! We now have {guild.boost_count} boosts.",
};

const channelOf = (ctx) => ctx.options.getChannel("channel") ?? ctx.channel;

function handlers(kind) {
  const label = LABEL[kind];
  return {
    add: {
      gate: "Manage Guild",
      defer: false, // opens the script modal
      async run(interaction, ctx) {
        const channel = channelOf(ctx);
        // Check before the modal so nobody writes a message that can't be sent.
        guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
        const existing = store.joinMessages.get(ctx.guild.id, kind, channel.id);
        const result = await ctx.promptScript({ title: `${label} message for #${channel.name}`, current: existing?.script ?? DEFAULTS[kind] });
        if (!result) return;
        const stored = script.validate(result.script);
        const selfDestruct = ctx.options.getInteger("self_destruct");
        // Boost messages always allow the booster's mention (no `pingable` option).
        const pingable = kind === "boost" ? false : ctx.options.getBoolean("pingable") ?? false;
        store.joinMessages.set(ctx.guild.id, kind, channel.id, { script: stored, selfDestruct, pingable });
        const extras = [selfDestruct ? `deleted after **${selfDestruct}s**` : null, kind !== "boost" ? (pingable ? "pings the member" : "no pings") : null].filter(Boolean);
        await ctx.success(`${existing ? "Updated" : "Added"} the ${label.toLowerCase()} message for ${channel}${extras.length ? ` (${extras.join(", ")})` : ""}. Preview it with \`/config ${kind === "boost" ? "boosts" : kind} view\`.`);
      },
    },

    remove: {
      gate: "Manage Guild",
      async run(interaction, ctx) {
        const channel = ctx.options.getChannel("channel", true);
        if (!store.joinMessages.remove(ctx.guild.id, kind, channel.id)) throw new UserError(`${channel} has no ${label.toLowerCase()} message.`);
        await ctx.success(`Removed the ${label.toLowerCase()} message from ${channel}.`);
      },
    },

    view: {
      gate: "Manage Guild",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const channel = channelOf(ctx);
        const row = store.joinMessages.get(ctx.guild.id, kind, channel.id);
        if (!row) throw new UserError(`${channel} has no ${label.toLowerCase()} message. Add one with \`/config ${kind === "boost" ? "boosts" : kind} add\`.`);
        const preview = script.render(withPing(row.script, row.pingable), { ...script.previewContext(interaction), channel, allowedMentions: { parse: [] } });
        const info = [
          `**${label} message for ${channel}**`,
          `Self-destruct: ${row.self_destruct ? `${row.self_destruct}s` : "off"}${kind !== "boost" ? ` • Pingable: ${row.pingable ? "yes" : "no"}` : ""}`,
          `Variables: ${JOIN_VARIABLES}`,
          "Raw script:",
          "```",
          row.script.slice(0, 1200).replace(/```/g, "ˋˋˋ"),
          "```",
        ].join("\n");
        await ctx.reply({ content: info.slice(0, 2000), embeds: [], components: [] });
        // The preview itself as a second ephemeral message, exactly as members will see it.
        await interaction.followUp({ ...preview, flags: MessageFlags.Ephemeral }).catch(() => {});
      },
    },

    list: {
      gate: "Manage Guild",
      async run(interaction, ctx) {
        const rows = store.joinMessages.list(ctx.guild.id, kind);
        const lines = rows.map((r) =>
          `<#${r.channel_id}> - ${r.self_destruct ? `self-destructs after ${r.self_destruct}s` : "permanent"}${kind !== "boost" ? `, ${r.pingable ? "pings" : "no ping"}` : ""}`);
        await ui.paginate(interaction, ui.listPages(ctx.client, `${label} messages`, lines, { empty: `No ${label.toLowerCase()} messages yet.` }));
      },
    },
  };
}

module.exports = { handlers, LABEL };
