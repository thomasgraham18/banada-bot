/**
 * /config stickymessage add|view|remove|list and /config imgonly add|remove|list
 */
const { MessageFlags, PermissionFlagsBits: P } = require("discord.js");
const { guard, script, ui, UserError } = require("../../../core");
const store = require("../db");
const stickyService = require("../sticky");

const channelOf = (ctx) => ctx.options.getChannel("channel") ?? ctx.channel;

const sticky = {
  add: {
    gate: "Manage Guild",
    defer: false, // opens the script modal
    async run(interaction, ctx) {
      const channel = channelOf(ctx);
      guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory]);
      const existing = store.sticky.get(ctx.guild.id, channel.id);
      const result = await ctx.promptScript({ title: `Sticky message for #${channel.name}`, current: existing?.script });
      if (!result) return;
      store.sticky.set(ctx.guild.id, channel.id, script.validate(result.script));
      // Post it right away so it's visible; later messages keep it at the bottom.
      const posted = await stickyService.repost(channel, { force: true });
      await ctx.success(`${existing ? "Updated" : "Added"} the sticky message in ${channel}.${posted ? "" : " (I couldn't post it yet; check my permissions there.)"}`);
    },
  },

  view: {
    gate: "Manage Guild",
    defer: "ephemeral",
    async run(interaction, ctx) {
      const channel = channelOf(ctx);
      const row = store.sticky.get(ctx.guild.id, channel.id);
      if (!row) throw new UserError(`${channel} has no sticky message.`);
      await ctx.reply({ content: `**Sticky message for ${channel}**\n\`\`\`\n${row.script.slice(0, 1700).replace(/```/g, "ˋˋˋ")}\n\`\`\``, embeds: [] });
      const preview = script.render(row.script, { ...script.previewContext(interaction), channel, allowedMentions: { parse: [] } });
      await interaction.followUp({ ...preview, flags: MessageFlags.Ephemeral }).catch(() => {});
    },
  },

  remove: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel", true);
      const row = store.sticky.remove(ctx.guild.id, channel.id);
      if (!row) throw new UserError(`${channel} has no sticky message.`);
      stickyService.cancel(channel.id);
      if (row.last_message_id) await channel.messages?.delete(row.last_message_id).catch(() => {});
      await ctx.success(`Removed the sticky message from ${channel}.`);
    },
  },

  list: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const lines = store.sticky.list(ctx.guild.id).map((r) => {
        const text = script.parseScript(r.script);
        const summary = (text.content || text.embed?.title || text.embed?.description || "embed").replace(/\s+/g, " ").slice(0, 60);
        return `<#${r.channel_id}> - ${summary}`;
      });
      await ui.paginate(interaction, ui.listPages(ctx.client, "Sticky messages", lines, { empty: "No sticky messages yet." }));
    },
  },
};

const imgonly = {
  add: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel", true);
      const thread = ctx.options.getBoolean("thread") ?? false;
      const needed = [P.ViewChannel, P.ManageMessages];
      if (thread) needed.push(P.CreatePublicThreads);
      guard.assertBotPermissions(channel, needed);
      store.gallery.set(ctx.guild.id, channel.id, thread);
      await ctx.success(`${channel} is now a gallery channel: messages without an image or video are deleted (staff are exempt)${thread ? ", and each image gets a discussion thread" : ""}.`);
    },
  },

  remove: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const channel = ctx.options.getChannel("channel", true);
      if (!store.gallery.remove(ctx.guild.id, channel.id)) throw new UserError(`${channel} isn't a gallery channel.`);
      await ctx.success(`${channel} is no longer a gallery channel.`);
    },
  },

  list: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const lines = store.gallery.list(ctx.guild.id).map((r) => `<#${r.channel_id}>${r.thread ? " (threads)" : ""}`);
      await ui.paginate(interaction, ui.listPages(ctx.client, "Gallery channels", lines, { empty: "No gallery channels yet." }));
    },
  },
};

module.exports = { sticky, imgonly };
