/**
 * /config: welcome/goodbye/boost messages, server images, the bot's
 * per-server profile, webhooks, sticky messages, gallery channels, aliases.
 * 9 groups, 39 subcommands. Handlers live in ../handlers/.
 */
const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { defineCommand } = require("../../../core");
const join = require("../handlers/joinMessages");
const assets = require("../handlers/assets");
const webhooks = require("../handlers/webhooks");
const channels = require("../handlers/channels");
const aliases = require("../handlers/aliases");

const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// Sticky / gallery also make sense in voice-channel chats and threads.
const CHAT = [...TEXT, ChannelType.GuildVoice, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];

const channelOpt = (description, required = false, types = TEXT) => (o) =>
  o.setName("channel").setDescription(description).setRequired(required).addChannelTypes(...types);
const selfDestruct = (o) => o.setName("self_destruct").setDescription("Delete the message after this many seconds (3-120)").setMinValue(3).setMaxValue(120);
const pingable = (o) => o.setName("pingable").setDescription("Ping the member (mention outside the embed)");
const urlOpt = (o) => o.setName("url").setDescription("Image URL");
const attachmentOpt = (o) => o.setName("attachment").setDescription("Image file");
const identifier = (o) => o.setName("identifier").setDescription("Webhook identifier").setRequired(true).setAutocomplete(true);

/** welcome / goodbye / boosts groups (same shape). */
function joinGroup(name, label, withPing) {
  return (g) =>
    g.setName(name).setDescription(`${label} messages`)
      .addSubcommand((s) => {
        s.setName("add").setDescription(`Add a ${label.toLowerCase()} message for a channel`)
          .addChannelOption(channelOpt("Channel to post in (default: this one)"))
          .addIntegerOption(selfDestruct);
        if (withPing) s.addBooleanOption(pingable);
        return s;
      })
      .addSubcommand((s) => s.setName("remove").setDescription(`Remove a ${label.toLowerCase()} message from a channel`)
        .addChannelOption(channelOpt("Channel", true)))
      .addSubcommand((s) => s.setName("view").setDescription(`View the ${label.toLowerCase()} message for a channel`)
        .addChannelOption(channelOpt("Channel (default: this one)")))
      .addSubcommand((s) => s.setName("list").setDescription(`View all ${label.toLowerCase()} messages`));
}

const imageSub = (name, description) => (s) =>
  s.setName(name).setDescription(description).addStringOption(urlOpt).addAttachmentOption(attachmentOpt);

const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription("Configure server messages, images, webhooks and more")
  .addSubcommandGroup(joinGroup("welcome", "Welcome", true))
  .addSubcommandGroup(joinGroup("goodbye", "Goodbye", true))
  .addSubcommandGroup(joinGroup("boosts", "Boost", false))
  .addSubcommandGroup((g) =>
    g.setName("set").setDescription("Server images")
      .addSubcommand(imageSub("icon", "Set a new server icon"))
      .addSubcommand(imageSub("splash", "Set a new server splash background"))
      .addSubcommand(imageSub("banner", "Set a new server banner")))
  .addSubcommandGroup((g) =>
    g.setName("customize").setDescription("Customize the bot in this server")
      .addSubcommand((s) => s.setName("namestyle").setDescription("Customize the bot's name in this server"))
      .addSubcommand(imageSub("avatar", "Customize the bot's server avatar (no image = reset)"))
      .addSubcommand(imageSub("banner", "Customize the bot's server banner (no image = reset)"))
      .addSubcommand((s) => s.setName("bio").setDescription("Customize the bot's server bio (no text = reset)")
        .addStringOption((o) => o.setName("text").setDescription("Bio text").setMaxLength(190))))
  .addSubcommandGroup((g) =>
    g.setName("webhook").setDescription("Webhooks")
      .addSubcommand((s) => s.setName("create").setDescription("Create a webhook in this channel to forward messages to")
        .addStringOption((o) => o.setName("name").setDescription("Webhook name (default: server name)").setMaxLength(80)))
      .addSubcommand((s) => s.setName("lock").setDescription("Lock your webhook from being accessed by others").addStringOption(identifier))
      .addSubcommand((s) => s.setName("unlock").setDescription("Unlock your webhook so others can use it").addStringOption(identifier))
      .addSubcommand((s) => s.setName("send").setDescription("Send a message through a webhook").addStringOption(identifier))
      .addSubcommand((s) => s.setName("edit").setDescription("Edit a message a webhook sent")
        .addStringOption((o) => o.setName("message_link").setDescription("Link to the webhook's message").setRequired(true)))
      .addSubcommand((s) => s.setName("delete").setDescription("Delete a webhook").addStringOption(identifier))
      .addSubcommand((s) => s.setName("list").setDescription("List all available webhooks in the server")))
  .addSubcommandGroup((g) =>
    g.setName("stickymessage").setDescription("Messages that stay at the bottom of a channel")
      .addSubcommand((s) => s.setName("add").setDescription("Add a sticky message to a channel")
        .addChannelOption(channelOpt("Channel (default: this one)", false, CHAT)))
      .addSubcommand((s) => s.setName("view").setDescription("View the sticky message for a channel")
        .addChannelOption(channelOpt("Channel (default: this one)", false, CHAT)))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove a sticky message from a channel")
        .addChannelOption(channelOpt("Channel", true, CHAT)))
      .addSubcommand((s) => s.setName("list").setDescription("View all sticky messages")))
  .addSubcommandGroup((g) =>
    g.setName("imgonly").setDescription("Gallery (image-only) channels")
      .addSubcommand((s) => s.setName("add").setDescription("Set a gallery channel")
        .addChannelOption(channelOpt("Channel", true, CHAT))
        .addBooleanOption((o) => o.setName("thread").setDescription("Open a discussion thread under each image")))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove a gallery channel")
        .addChannelOption(channelOpt("Channel", true, CHAT)))
      .addSubcommand((s) => s.setName("list").setDescription("View all gallery channels")))
  .addSubcommandGroup((g) =>
    g.setName("alias").setDescription("Shortcuts for commands (server slash commands)")
      .addSubcommand((s) => s.setName("add").setDescription("Create an alias for a command")
        .addStringOption((o) => o.setName("shortcut").setDescription("New command name, e.g. rank").setRequired(true).setMaxLength(32))
        .addStringOption((o) => o.setName("command").setDescription("Command it runs, e.g. levels rank").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove an alias for a command")
        .addStringOption((o) => o.setName("shortcut").setDescription("Alias").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("removeall").setDescription("Remove every alias for a command")
        .addStringOption((o) => o.setName("command").setDescription("Command").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("view").setDescription("View the command an alias runs")
        .addStringOption((o) => o.setName("shortcut").setDescription("Alias").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("reset").setDescription("Reset every alias for all commands"))
      .addSubcommand((s) => s.setName("list").setDescription("List every alias for all commands")));

const prefixed = (group, map) => Object.fromEntries(Object.entries(map).map(([sub, h]) => [`${group} ${sub}`, h]));

module.exports = defineCommand({
  data,
  module: "config",
  // Only `webhook list` is open to everyone; not worth showing members an
  // admin command for. Hidden from non-admins (running is still level-checked).
  visibility: require("discord.js").PermissionFlagsBits.ManageGuild,
  handlers: {
    ...prefixed("welcome", join.handlers("welcome")),
    ...prefixed("goodbye", join.handlers("goodbye")),
    ...prefixed("boosts", join.handlers("boost")),
    ...prefixed("set", assets.set),
    ...prefixed("customize", assets.customize),
    ...prefixed("webhook", webhooks.handlers),
    ...prefixed("stickymessage", channels.sticky),
    ...prefixed("imgonly", channels.imgonly),
    ...prefixed("alias", aliases.handlers),
  },
  autocomplete: {
    "webhook lock": webhooks.autocomplete,
    "webhook unlock": webhooks.autocomplete,
    "webhook send": webhooks.autocomplete,
    "webhook delete": webhooks.autocomplete,
    "alias add": aliases.autocomplete.target,
    "alias remove": aliases.autocomplete.shortcut,
    "alias view": aliases.autocomplete.shortcut,
    "alias removeall": aliases.autocomplete.aliased,
  },
});
