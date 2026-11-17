/**
 * /config listeners. Everything here reads the guildCache-backed getters in
 * db.js, so no event queries the database.
 *
 *   guildMemberAdd      -> welcome messages        (event "welcome")
 *   guildMemberRemove   -> goodbye messages        (event "goodbye")
 *   guildMemberUpdate   -> boost messages          (event "boost_message")
 *   messageCreate       -> sticky messages         (event "sticky_message")
 *   messageCreate       -> gallery channels        (event "imgonly")
 *   channelDelete       -> forget deleted channels
 *   clientReady         -> re-create missing alias commands
 */
const { PermissionFlagsBits: P } = require("discord.js");
const { listeners, access, guard, script } = require("../../core");
const store = require("./db");
const stickyService = require("./sticky");
const aliases = require("./aliases");
const { withPing, allowedMentions, isGalleryMessage, mightGetEmbed } = require("./lib");

const EVENT = { welcome: "welcome", goodbye: "goodbye", boost: "boost_message" };

/** Posts every configured welcome/goodbye/boost message for `member`. */
async function postJoinMessages(kind, member) {
  const guild = member.guild;
  for (const row of store.joinMessages.list(guild.id, kind)) {
    const channel = guild.channels.cache.get(row.channel_id);
    if (!channel?.isTextBased()) continue;
    // The listener-level check only sees the guild; /access event can also be channel-scoped.
    if (access.eventDisabled(guild.id, EVENT[kind], channel)) continue;
    const perms = channel.permissionsFor(guild.members.me);
    if (!perms?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) continue;

    // Boost messages always allow the booster's mention; welcome/goodbye follow `pingable`.
    const stored = kind === "boost" ? row.script : withPing(row.script, row.pingable);
    const mentions = allowedMentions(member.id, kind === "boost" || Boolean(row.pingable));
    try {
      await script.send(channel, stored, { member, guild, allowedMentions: mentions }, { selfDestruct: row.self_destruct ?? 0 });
    } catch (err) {
      console.warn(`[config:${kind}] couldn't post in #${channel.name} (${guild.id}): ${err.message}`);
    }
  }
}

// Boost detection can see the same boost twice (member update + a later cache
// refresh), so remember recent boosters for a few minutes.
const recentBoosts = new Map();
const BOOST_DEDUPE_MS = 5 * 60_000;

function isNewBoost(oldMember, newMember) {
  if (!newMember.premiumSinceTimestamp) return false;
  if (!oldMember.partial) return !oldMember.premiumSinceTimestamp;
  // The old member wasn't cached: only count boosts that started just now.
  return Date.now() - newMember.premiumSinceTimestamp < 60_000;
}

module.exports = function registerListeners() {
  listeners.on("guildMemberAdd", { name: "config:welcome", module: "config", event: "welcome" }, async (client, member) => {
    await postJoinMessages("welcome", member);
  });

  listeners.on("guildMemberRemove", { name: "config:goodbye", module: "config", event: "goodbye" }, async (client, member) => {
    await postJoinMessages("goodbye", member);
  });

  listeners.on("guildMemberUpdate", { name: "config:boost", module: "config", event: "boost_message" }, async (client, oldMember, newMember) => {
    if (!store.joinMessages.list(newMember.guild.id, "boost").length) return;
    if (!isNewBoost(oldMember, newMember)) return;
    const key = `${newMember.guild.id}:${newMember.id}`;
    const last = recentBoosts.get(key);
    if (last && Date.now() - last < BOOST_DEDUPE_MS) return;
    recentBoosts.set(key, Date.now());
    for (const [k, t] of recentBoosts) if (Date.now() - t > BOOST_DEDUPE_MS) recentBoosts.delete(k);
    await postJoinMessages("boost", newMember);
  });

  listeners.on("messageCreate", { name: "config:sticky", module: "config", event: "sticky_message" }, async (client, message) => {
    if (!message.inGuild()) return;
    const row = store.sticky.get(message.guildId, message.channelId);
    if (!row) return;
    // Our own sticky post must not trigger another repost. (A repost that races
    // with this check is harmless: repost() skips when the sticky is already last.)
    if (message.author.id === client.user.id && message.id === row.last_message_id) return;
    stickyService.schedule(message.channel);
  });

  listeners.on("messageCreate", { name: "config:imgonly", module: "config", event: "imgonly" }, async (client, message) => {
    if (!message.inGuild() || message.system) return;
    const gallery = store.gallery.get(message.guildId, message.channelId);
    if (!gallery) return;
    if (message.author.id === client.user.id) return;
    if (message.member && guard.isStaff(message.member)) return;

    let ok = isGalleryMessage(message);
    if (!ok && mightGetEmbed(message)) {
      // Link previews arrive a moment after the message itself. Re-check later
      // in the background: awaiting here would hold up every listener after
      // this one (they run one at a time).
      setTimeout(() => recheckGallery(message, gallery).catch((err) => console.error("[config:imgonly]", err)), 3000);
      return;
    }
    await applyGallery(message, gallery, ok);
  });

  async function recheckGallery(message, gallery) {
    const fresh = await message.fetch().catch(() => null);
    if (!fresh) return; // already deleted
    await applyGallery(fresh, gallery, isGalleryMessage(fresh));
  }

  async function applyGallery(message, gallery, ok) {

    if (ok) {
      if (gallery.thread && !message.hasThread && message.channel.threads) {
        await message.startThread({ name: `${message.member?.displayName ?? message.author.username}'s post`.slice(0, 100), autoArchiveDuration: 1440 }).catch(() => {});
      }
      return;
    }
    const perms = message.channel.permissionsFor(message.guild.members.me);
    if (!perms?.has(P.ManageMessages)) return;
    await message.delete().catch(() => {});
  }

  listeners.on("channelDelete", { name: "config:channel-cleanup" }, async (client, channel) => {
    if (!channel.guildId) return;
    stickyService.cancel(channel.id);
    store.forgetChannel(channel.guildId, channel.id);
  });

  listeners.on("clientReady", { name: "config:alias-resync" }, async (client) => {
    await aliases.resync(client);
  });
};

module.exports.isNewBoost = isNewBoost;
