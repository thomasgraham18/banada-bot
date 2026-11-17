/**
 * /bumpreminder: DISBOARD bump reminders (guide WP13). Every subcommand is
 * gated on Manage Channels.
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, guard, script, ui, embeds, ensure } = require("../../../core");
const store = require("../db");
const logic = require("../logic");
const service = require("../service");

const GATE = "Manage Channels";

const setting = (s, description) =>
  s.addBooleanOption((o) => o.setName("setting").setDescription(description).setRequired(true));

const data = new SlashCommandBuilder()
  .setName("bumpreminder")
  .setDescription("Remind your server to /bump on DISBOARD")
  .addSubcommand((s) => s.setName("on").setDescription("Enable bump reminders"))
  .addSubcommand((s) => s.setName("off").setDescription("Disable bump reminders"))
  .addSubcommand((s) =>
    s.setName("channel").setDescription("Set the Bump Reminder channel for the server")
      .addChannelOption((o) => o.setName("channel").setDescription("Where members run /bump").setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) =>
    s.setName("message").setDescription("Set the reminder message to run /bump")
      .addBooleanOption((o) => o.setName("pingable").setDescription("Ping the last bumper (and roles written in the message)")))
  .addSubcommand((s) => s.setName("messageview").setDescription("View the current reminder message"))
  .addSubcommand((s) => s.setName("thankyou").setDescription("Set the Thank You message for a successful /bump"))
  .addSubcommand((s) => s.setName("thankyouview").setDescription("View the current Thank You message"))
  .addSubcommand((s) => setting(s.setName("autolock").setDescription("Lock the channel until it is ready to /bump"), "Lock the channel between bumps"))
  .addSubcommand((s) => setting(s.setName("autoclean").setDescription("Automatically delete messages that aren't /bump"), "Delete other messages in the channel"))
  .addSubcommand((s) => s.setName("config").setDescription("View this server's bump reminder configuration"))
  .addSubcommand((s) =>
    s.setName("clear").setDescription("Remove the bump channel, the reminder, or the thank-you")
      .addStringOption((o) => o.setName("setting").setDescription("What to remove").setRequired(true)
        .addChoices(
          { name: "channel", value: "channel" },
          { name: "message", value: "message" },
          { name: "thankyou", value: "thankyou" }
        )));

const yesNo = (b) => (b ? "on" : "off");
const varList = (vars) => Object.entries(vars).map(([k, v]) => `\`${k}\` ${v}`).join("\n");

/** The configured channel object, or null. */
const bumpChannel = (guild, settings) => (settings.channel_id ? guild.channels.cache.get(settings.channel_id) ?? null : null);

/** Bot permissions each optional feature needs in the bump channel. */
const NEEDS = {
  base: [P.ViewChannel, P.SendMessages, P.EmbedLinks],
  autolock: [P.ManageRoles],
  autoclean: [P.ManageMessages],
};

/** A rendered script plus an info embed underneath, for the view subcommands. */
function preview(interaction, ctx, stored, vars, note) {
  const payload = script.render(stored, { ...script.previewContext(interaction, vars), allowedMentions: { parse: [] } });
  const info = embeds.info(ctx.client, note, "Preview");
  return { ...payload, embeds: [...payload.embeds.slice(0, 9), info] };
}

async function setScript(interaction, ctx, column, title, current) {
  const result = await ctx.promptScript({ title, current });
  if (!result) return;
  const fields = { [column]: result.script };
  const pingable = interaction.options.getBoolean("pingable");
  if (column === "reminder_script" && pingable !== null) fields.pingable = pingable;
  store.update(ctx.guild.id, fields);
  await ctx.success(`${column === "reminder_script" ? "Reminder" : "Thank-you"} message saved.${fields.pingable != null ? ` Pinging is **${yesNo(fields.pingable)}**.` : ""}`);
}

module.exports = defineCommand({
  data,
  module: "bumpreminder",
  gate: GATE,
  handlers: {
    on: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const settings = store.get(ctx.guild.id);
        const channel = bumpChannel(ctx.guild, settings);
        ensure(channel, "Set a channel first with `/bumpreminder channel`.");
        guard.assertBotPermissions(channel, NEEDS.base);
        store.update(ctx.guild.id, { enabled: true });
        await ctx.success(`Bump reminders are **on** in ${channel}. I'll remind you 2 hours after each successful **/bump**.`);
      },
    },

    off: {
      gate: GATE,
      run: async (interaction, ctx) => {
        store.update(ctx.guild.id, { enabled: false, next_bump_at: null });
        await service.cancel(ctx.client, ctx.guild.id);
        await ctx.success("Bump reminders are **off**. Any pending reminder was cancelled.");
      },
    },

    channel: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const channel = interaction.options.getChannel("channel", true);
        const settings = store.get(ctx.guild.id);
        guard.assertBotPermissions(channel, NEEDS.base);
        if (settings.autolock) guard.assertBotPermissions(channel, NEEDS.autolock);
        if (settings.autoclean) guard.assertBotPermissions(channel, NEEDS.autoclean);
        store.update(ctx.guild.id, { channel_id: channel.id });
        await ctx.success(`Bump channel set to ${channel}.${settings.enabled ? "" : " Turn reminders on with `/bumpreminder on`."}`);
      },
    },

    message: {
      gate: GATE,
      defer: false,
      run: (interaction, ctx) =>
        setScript(interaction, ctx, "reminder_script", "Bump reminder message", logic.reminderScript(store.get(ctx.guild.id))),
    },

    messageview: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const settings = store.get(ctx.guild.id);
        const payload = preview(interaction, ctx, logic.reminderScript(settings), { last_bumper: `${ctx.user}`, "last_bumper.id": ctx.user.id },
          `${settings.reminder_script ? "Custom" : "Default"} reminder. Pinging is **${yesNo(settings.pingable)}**.\n\n**Variables**\n${varList(logic.REMINDER_VARIABLES)}\nplus the usual \`{guild.*}\`, \`{channel}\`... variables.`);
        await ctx.reply(logic.withPing(payload, settings.pingable, ctx.user.id));
      },
    },

    thankyou: {
      gate: GATE,
      defer: false,
      run: (interaction, ctx) =>
        setScript(interaction, ctx, "thankyou_script", "Bump thank-you message", logic.thankyouScript(store.get(ctx.guild.id)) ?? logic.DEFAULT_THANKYOU),
    },

    thankyouview: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const settings = store.get(ctx.guild.id);
        const stored = logic.thankyouScript(settings);
        if (!stored) return ctx.info("The thank-you message is **off**. Set one with `/bumpreminder thankyou`.", "Thank-you message");
        const next = `<t:${Math.floor((Date.now() + logic.BUMP_COOLDOWN_MS) / 1000)}:R>`;
        await ctx.reply(preview(interaction, ctx, stored, { next_bump: next },
          `${settings.thankyou_script ? "Custom" : "Default"} thank-you.\n\n**Variables**\n${varList(logic.THANKYOU_VARIABLES)}`));
      },
    },

    autolock: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const on = interaction.options.getBoolean("setting", true);
        const channel = bumpChannel(ctx.guild, store.get(ctx.guild.id));
        if (on && channel) guard.assertBotPermissions(channel, NEEDS.autolock);
        store.update(ctx.guild.id, { autolock: on });
        await ctx.success(on
          ? "Autolock is **on**: after a bump, @everyone can't send messages or use commands in the bump channel until the reminder."
          : "Autolock is **off**. A channel locked right now unlocks when the pending reminder fires.");
      },
    },

    autoclean: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const on = interaction.options.getBoolean("setting", true);
        const channel = bumpChannel(ctx.guild, store.get(ctx.guild.id));
        if (on && channel) guard.assertBotPermissions(channel, NEEDS.autoclean);
        store.update(ctx.guild.id, { autoclean: on });
        await ctx.success(on
          ? "Autoclean is **on**: messages in the bump channel that aren't from DISBOARD or me are deleted after a few seconds."
          : "Autoclean is **off**.");
      },
    },

    config: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const s = store.get(ctx.guild.id);
        const job = service.pendingJob(ctx.guild.id);
        const next = job ? `<t:${Math.floor(job.run_at / 1000)}:R>` : s.next_bump_at && s.next_bump_at > Date.now() ? `<t:${Math.floor(s.next_bump_at / 1000)}:R>` : "Ready to bump";
        const embed = embeds.info(ctx.client, `Bump reminders are **${yesNo(s.enabled)}**.`, "Bump reminder").addFields(
          { name: "Channel", value: s.channel_id ? `<#${s.channel_id}>` : "Not set", inline: true },
          { name: "Reminder", value: `${s.reminder_script ? "Custom" : "Default"}, ping ${yesNo(s.pingable)}`, inline: true },
          { name: "Thank-you", value: s.thankyou_script == null ? "Default" : s.thankyou_script ? "Custom" : "Off", inline: true },
          { name: "Autolock", value: yesNo(s.autolock), inline: true },
          { name: "Autoclean", value: yesNo(s.autoclean), inline: true },
          { name: "Locked now", value: job?.payload?.restore ? "yes" : "no", inline: true },
          { name: "Next bump", value: next, inline: true },
          { name: "Last bumper", value: s.last_bumper_id ? `<@${s.last_bumper_id}>` : "Nobody yet", inline: true }
        );
        await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      },
    },

    clear: {
      gate: GATE,
      run: async (interaction, ctx) => {
        const what = interaction.options.getString("setting", true);
        const text = {
          channel: "Remove the bump channel? Reminders stop until you set a new one, and any pending reminder is cancelled.",
          message: "Reset the reminder message to the default?",
          thankyou: "Remove the thank-you message? Nothing will be sent after a bump.",
        }[what];
        if (!(await ui.confirm(interaction, text))) return;

        if (what === "channel") {
          store.update(ctx.guild.id, { channel_id: null, next_bump_at: null });
          await service.cancel(ctx.client, ctx.guild.id);
        } else if (what === "message") store.update(ctx.guild.id, { reminder_script: null });
        else store.update(ctx.guild.id, { thankyou_script: "" });

        await ctx.success({ channel: "Bump channel removed.", message: "Reminder message reset to the default.", thankyou: "Thank-you message removed." }[what]);
      },
    },
  },
});
