/**
 * Event listeners for /automation. Everything on a hot path (every message,
 * every voice change) reads cached data only.
 */
const { ChannelType, MessageFlags } = require("discord.js");
const { listeners, components } = require("../../core");
const store = require("./db");
const activity = require("./activity");
const pins = require("./pins");
const pagination = require("./pagination");
const leaderboards = require("./leaderboards");

// Discord allows 10 publishes per channel per hour. discord.js would queue
// an 11th request for up to an hour, so we stop ourselves first.
const PUBLISH_LIMIT = 10;
const HOUR = 3_600_000;
const publishLog = new Map(); // channelId -> [timestamps]

function canPublish(channelId, now = Date.now()) {
  const recent = (publishLog.get(channelId) ?? []).filter((t) => now - t < HOUR);
  publishLog.set(channelId, recent);
  if (recent.length >= PUBLISH_LIMIT) return false;
  recent.push(now);
  return true;
}

module.exports = function setup() {
  // Publisher: crosspost every message in listed announcement channels.
  listeners.on("messageCreate", { name: "automation:publisher", module: "automation", event: "publisher" }, async (client, message) => {
    if (!message.inGuild() || message.channel.type !== ChannelType.GuildAnnouncement) return;
    if (!store.publisher.has(message.guildId, message.channelId)) return;
    if (message.flags.has(MessageFlags.Crossposted) || !message.crosspostable) return;
    if (!canPublish(message.channelId)) return;
    // Not awaited: a slow publish must not hold up other listeners.
    message.crosspost().catch((err) => console.warn(`[automation] publish in #${message.channel.name} failed: ${err.message}`));
  });

  // Leaderboard tracking: message counts.
  listeners.on("messageCreate", { name: "automation:messages", module: "automation" }, async (client, message) => {
    if (!message.inGuild() || message.author.bot || message.system) return;
    if (!store.trackedKinds.get(message.guildId).has("messages")) return;
    activity.bump(message.guildId, "messages", message.author.id);
  });

  // Leaderboard tracking: voice time.
  listeners.on("voiceStateUpdate", { name: "automation:voice", module: "automation" }, async (client, oldState, newState) => {
    activity.voiceUpdate(oldState, newState);
  });

  // Leaderboard tracking: invites.
  listeners.on("guildMemberAdd", { name: "automation:invites", module: "automation" }, async (client, member) => {
    await activity.memberJoined(member);
  });

  // Pin archive.
  listeners.on(
    "channelPinsUpdate",
    { name: "automation:pins", module: "automation", scope: (channel) => ({ guildId: channel?.guildId ?? null, channel, userId: null }) },
    async (client, channel) => {
      await pins.onPinsUpdate(channel);
    }
  );

  // Boot: resume voice sessions, cache invite counts, start the flush loop.
  listeners.on("clientReady", { name: "automation:ready" }, async (client) => {
    activity.seedVoice(client);
    for (const guildId of store.boards.guildsWithKind("invites")) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) await activity.seedInvites(guild);
    }
    leaderboards.ensurePruneJob();
  });
  activity.start();

  // Persistent components: "auto:pg:<prev|next|count>:<page>".
  // "auto:modal:*" are short-lived modals awaited by their command; ignore them here.
  components.register("auto", async (interaction, client, [area, action, page]) => {
    if (area === "pg" && interaction.isButton() && (action === "prev" || action === "next")) return pagination.onButton(interaction, action, page);
  });
};

module.exports.canPublish = canPublish;
