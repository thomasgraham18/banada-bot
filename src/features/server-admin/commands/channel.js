/**
 * /channel pin | unpin | firstmessage (the server-management subset of Bleed's
 * /channel; poll/quickpoll belong to another section).
 */
const { SlashCommandBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, parse, guard, embeds, ensure, UserError } = require("../../../core");

// Discord split "Pin Messages" out of Manage Messages in 2025; older libraries lack the flag.
const PIN_FLAG = P.PinMessages ?? P.ManageMessages;

const messageArg = (s, description) => s.addStringOption((o) => o.setName("message").setDescription(description));

/** Newest message in the channel that isn't this command's own response. */
async function latestMessage(interaction) {
  const recent = await interaction.channel.messages.fetch({ limit: 5 }).catch(() => null);
  const message = recent?.find((m) => m.interactionMetadata?.id !== interaction.id && !m.system);
  if (!message) throw new UserError("I couldn't find a message to pin here. Give a message link or ID.");
  return message;
}

function assertCanPin(channel) {
  const perms = channel.permissionsFor(channel.guild.members.me);
  if (!perms?.has(PIN_FLAG) && !perms?.has(P.ManageMessages))
    throw new UserError(`I need the **Pin Messages** permission in ${channel}.`);
}

module.exports = defineCommand({
  data: new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Channel utilities")
    .addSubcommand((s) => messageArg(s.setName("pin").setDescription("Pin a message"), "Message link or ID (default: the latest message)"))
    .addSubcommand((s) => messageArg(s.setName("unpin").setDescription("Unpin a message"), "Message link or ID (default: the latest pin)"))
    .addSubcommand((s) => s.setName("firstmessage").setDescription("Jump to the first message in a channel")
      .addChannelOption((o) => o.setName("channel").setDescription("Channel (default: this one)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice,
          ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread))),
  handlers: {
    pin: {
      gate: "Manage Messages",
      // Ephemeral so the "thinking…" response isn't the latest message we'd pin.
      defer: "ephemeral",
      async run(interaction, ctx) {
        const text = ctx.options.getString("message");
        const message = text ? await parse.fetchMessage(interaction, text) : await latestMessage(interaction);
        assertCanPin(message.channel);
        ensure(!message.pinned, `[That message](${message.url}) is already pinned.`);
        await message.pin(`/channel pin by ${ctx.user.tag}`);
        return ctx.success(`Pinned [this message](${message.url}).`);
      },
    },
    unpin: {
      gate: "Manage Messages",
      defer: "ephemeral",
      async run(interaction, ctx) {
        const text = ctx.options.getString("message");
        let message;
        if (text) message = await parse.fetchMessage(interaction, text);
        else {
          const pins = await ctx.channel.messages.fetchPins({ limit: 1 });
          message = pins.items[0]?.message;
          ensure(message, "There are no pinned messages in this channel.");
        }
        assertCanPin(message.channel);
        ensure(message.pinned !== false, `[That message](${message.url}) isn't pinned.`);
        await message.unpin(`/channel unpin by ${ctx.user.tag}`);
        return ctx.success(`Unpinned [this message](${message.url}).`);
      },
    },
    firstmessage: {
      async run(interaction, ctx) {
        const channel = ctx.options.getChannel("channel") ?? ctx.channel;
        // Don't reveal channels the member can't read.
        const mine = channel.permissionsFor(ctx.member);
        ensure(mine?.has([P.ViewChannel, P.ReadMessageHistory]), `You can't read the history of ${channel}.`);
        guard.assertBotPermissions(channel, [P.ViewChannel, P.ReadMessageHistory]);
        const first = (await channel.messages.fetch({ after: "0", limit: 1 })).first();
        ensure(first, `${channel} has no messages.`);
        const button = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Jump to message").setURL(first.url);
        return ctx.reply({
          embeds: [embeds.info(ctx.client, `First message in ${channel}, sent by ${first.author} ${parse.timestamp(first.createdAt)}.`)],
          components: [new ActionRowBuilder().addComponents(button)],
          allowedMentions: { parse: [] },
        });
      },
    },
  },
});
