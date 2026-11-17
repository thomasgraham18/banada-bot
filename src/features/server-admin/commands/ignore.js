/**
 * /ignore: members or channels the bot ignores (commands and listeners).
 * Administrators are never ignored (core/access.js). Writes go through
 * core.access so its caches stay in sync.
 */
const { SlashCommandBuilder } = require("discord.js");
const { defineCommand, access, guard, ui, ensure } = require("../../../core");

const targetOptions = (s) =>
  s
    .addUserOption((o) => o.setName("member").setDescription("A member"))
    .addChannelOption((o) => o.setName("channel").setDescription("A channel or category"));

/** The member and/or channel given; at least one is required. */
function targets(ctx) {
  const user = ctx.options.getUser("member");
  const channel = ctx.options.getChannel("channel");
  ensure(user || channel, "Give a **member**, a **channel**, or both.");
  return [user && { id: user.id, type: "member", label: `${user}` }, channel && { id: channel.id, type: "channel", label: `${channel}` }].filter(Boolean);
}

module.exports = defineCommand({
  data: new SlashCommandBuilder()
    .setName("ignore")
    .setDescription("Make the bot ignore members or channels")
    .addSubcommand((s) => targetOptions(s.setName("add").setDescription("Ignore a member or channel")))
    .addSubcommand((s) => targetOptions(s.setName("remove").setDescription("Stop ignoring a member or channel")))
    .addSubcommand((s) => s.setName("list").setDescription("View a list of ignored members or channels")),
  handlers: {
    add: {
      gate: "Administrator",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const list = targets(ctx);
        const member = list.find((t) => t.type === "member");
        if (member) {
          const target = await ctx.guild.members.fetch(member.id).catch(() => null);
          ensure(!target || !guard.isAdmin(target), "Administrators can't be ignored (they bypass /ignore).");
          ensure(member.id !== ctx.client.user.id, "I can't ignore myself.");
        }
        for (const t of list) access.setIgnored(ctx.guild.id, t.id, t.type, true);
        return ctx.success(`Now ignoring ${list.map((t) => t.label).join(" and ")}.`);
      },
    },
    remove: {
      gate: "Administrator",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const list = targets(ctx);
        const ignored = new Set(access.listIgnored(ctx.guild.id).map((r) => r.target_id));
        const removed = list.filter((t) => ignored.has(t.id));
        ensure(removed.length, `${list.map((t) => t.label).join(" and ")} ${list.length > 1 ? "aren't" : "isn't"} ignored.`);
        for (const t of removed) access.setIgnored(ctx.guild.id, t.id, t.type, false);
        return ctx.success(`No longer ignoring ${removed.map((t) => t.label).join(" and ")}.`);
      },
    },
    list: {
      gate: "Administrator",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const rows = access.listIgnored(ctx.guild.id).sort((a, b) => a.type.localeCompare(b.type));
        const lines = rows.map((r) => (r.type === "member" ? `👤 <@${r.target_id}>` : `#️⃣ <#${r.target_id}>`));
        return ui.paginate(interaction, ui.listPages(ctx.client, "Ignored members & channels", lines, { empty: "Nothing is ignored." }));
      },
    },
  },
});
