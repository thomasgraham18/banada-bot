/**
 * /antiraid honeypot: bait channels. Only the honeypot group belongs to this
 * project; the rest of Bleed's /antiraid is Moderation & Security (out of scope).
 * The punishing happens in ../listeners.js.
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits: P, EmbedBuilder } = require("discord.js");
const { defineCommand, guard, ui, embeds, ensure } = require("../../../core");
const store = require("../db");

const PUNISHMENTS = ["ban", "kick", "timeout", "jail"];
/** What the bot needs to carry out each punishment (plus Manage Messages to delete the bait message). */
const NEEDS = { ban: [P.BanMembers], kick: [P.KickMembers], timeout: [P.ModerateMembers], jail: [P.ManageRoles] };

module.exports = defineCommand({
  data: new SlashCommandBuilder()
    .setName("antiraid")
    .setDescription("Anti-raid tools")
    .addSubcommandGroup((g) => g.setName("honeypot").setDescription("Bait channels that punish anyone who posts in them")
      .addSubcommand((s) => s.setName("add").setDescription("Turn a channel into a bait channel")
        .addChannelOption((o) => o.setName("channel").setDescription("The bait channel").setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName("punishment").setDescription("What happens to anyone who posts (default: ban)")
          .addChoices(...PUNISHMENTS.map((p) => ({ name: p, value: p })))))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove a bait channel")
        .addChannelOption((o) => o.setName("channel").setDescription("The bait channel").setRequired(true).addChannelTypes(ChannelType.GuildText)))),
  handlers: {
    "honeypot add": {
      gate: "Administrator",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const channel = ctx.options.getChannel("channel", true);
        const punishment = ctx.options.getString("punishment") ?? "ban";
        guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ManageMessages]);
        guard.assertBotPermissions(ctx.guild, NEEDS[punishment]);
        store.honeypots.add(ctx.guild.id, channel.id, punishment, ctx.user.id);

        // Warn real members so they don't fall in.
        const warning = new EmbedBuilder()
          .setColor(embeds.COLOURS.error)
          .setTitle("⚠️ Do not send messages in this channel")
          .setDescription(`This is a trap for spam bots. Anyone who sends a message here is **${punishment === "ban" ? "banned" : punishment === "kick" ? "kicked" : punishment === "timeout" ? "timed out" : "jailed"}** automatically.`);
        const sent = await ui.safeSend(channel, { embeds: [warning] });
        return ctx.success(`${channel} is now a honeypot (**${punishment}**). Staff and administrators are never punished.${sent ? "" : "\n⚠️ I couldn't post the warning there."}`);
      },
    },
    "honeypot remove": {
      gate: "Administrator",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const channel = ctx.options.getChannel("channel", true);
        ensure(store.honeypots.remove(ctx.guild.id, channel.id), `${channel} isn't a honeypot.`);
        return ctx.success(`${channel} is no longer a honeypot.`);
      },
    },
  },
});
