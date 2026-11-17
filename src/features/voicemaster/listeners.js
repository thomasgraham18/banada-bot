/**
 * VoiceMaster listeners:
 *   voiceStateUpdate  join to create, channel/join roles, delete empty temp channels
 *   channelDelete     forget channels that were deleted by hand
 *   clientReady       sweep after a restart (delete empty temp channels, drop rows for gone ones)
 *
 * The music player has its own voiceStateUpdate in src/events; this one runs
 * alongside it. Bots' voice changes (including our own music player joining
 * or leaving) are ignored, and a channel is only deleted once no humans are
 * left in it, so music is never cut off while people are listening.
 *
 * No module/event is set on these registrations on purpose: cleanup must run
 * even if /access or /ignore cover the voice channel or the member.
 */
const { listeners } = require("../../core");
const store = require("./db");
const service = require("./service");
const logic = require("./logic");

/** Someone joined the hub: move them to their channel, or make one. */
async function handleHub(member, cfg) {
  const guild = member.guild;

  // Already own a channel (left it with people still inside)? Send them back to it.
  const owned = store.ownedBy(guild.id, member.id);
  if (owned) {
    const channel = guild.channels.cache.get(owned.channel_id);
    if (channel) return void (await member.voice.setChannel(channel, "VoiceMaster: back to your channel").catch(() => {}));
    store.removeChannel(guild.id, owned.channel_id);
  }

  // Anti-spam: one new channel per member per cooldown.
  const wait = service.createLimiter.take(`${guild.id}:${member.id}`);
  if (wait) {
    await member.voice.disconnect("VoiceMaster: creation cooldown").catch(() => {});
    await member
      .send(`You're creating voice channels too quickly in **${guild.name}**. Try again in ${Math.ceil(wait / 1000)}s.`)
      .catch(() => {});
    return;
  }

  try {
    await service.createTempChannel(member, cfg);
  } catch (err) {
    console.warn(`[voicemaster] couldn't create a channel in ${guild.name}: ${err.message}`);
  }
}

async function onVoiceStateUpdate(client, oldState, newState) {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return; // never react to bots, including ourselves
  if (oldState.channelId === newState.channelId) return; // mute/deafen/stream changes
  const guild = newState.guild;
  const cfg = store.getConfig(guild.id);

  // Left a temp channel: take back its role, delete it if no humans remain.
  if (oldState.channelId) {
    const row = store.getChannel(guild.id, oldState.channelId);
    if (row) {
      if (row.role_id) await service.removeRole(member, row.role_id, "VoiceMaster: left channel");
      if (logic.isEmptyOfHumans(oldState.channel)) await service.deleteTempChannel(guild, oldState.channelId);
    }
  }

  if (newState.channelId) {
    if (cfg?.hub_channel_id && newState.channelId === cfg.hub_channel_id) await handleHub(member, cfg);
    else {
      const row = store.getChannel(guild.id, newState.channelId);
      if (row?.role_id) await service.addRole(member, row.role_id, "VoiceMaster: joined channel");
    }
  }

  // Join role: held while in the hub or any temp channel. Re-read voice state,
  // since handleHub may have moved or disconnected the member.
  if (cfg?.join_role_id) {
    const now = member.voice.channelId;
    const inVm = Boolean(now && (now === cfg.hub_channel_id || store.getChannel(guild.id, now)));
    if (inVm) await service.addRole(member, cfg.join_role_id, "VoiceMaster: in a voice channel");
    else await service.removeRole(member, cfg.join_role_id, "VoiceMaster: left voice");
  }
}

function onChannelDelete(client, channel) {
  if (!channel.guildId) return;
  const guildId = channel.guildId;
  if (store.getChannel(guildId, channel.id)) store.removeChannel(guildId, channel.id);

  // Forget configured channels/categories that no longer exist.
  const cfg = store.getConfig(guildId);
  if (!cfg) return;
  const cleared = {};
  for (const column of ["hub_channel_id", "interface_channel_id", "public_category_id", "private_category_id", "created_category_id"])
    if (cfg[column] === channel.id) cleared[column] = null;
  if (Object.keys(cleared).length) store.setConfig(guildId, cleared);
}

/**
 * After a restart the voice events we missed are gone, so reconcile:
 * drop rows for channels that no longer exist, delete temp channels with no
 * humans inside, and take the join role from cached members not in VoiceMaster.
 */
async function sweep(client) {
  let deleted = 0;
  let dropped = 0;
  const byGuild = new Map();
  for (const row of store.allChannels()) {
    if (!byGuild.has(row.guild_id)) byGuild.set(row.guild_id, []);
    byGuild.get(row.guild_id).push(row);
  }

  for (const [guildId, rows] of byGuild) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      // The bot was removed from this server: nothing left to manage.
      store.removeGuildChannels(guildId);
      dropped += rows.length;
      continue;
    }
    if (!guild.available) continue; // outage: try again next restart
    for (const row of rows) {
      const channel = guild.channels.cache.get(row.channel_id);
      if (!channel) {
        store.removeChannel(guildId, row.channel_id);
        dropped++;
      } else if (logic.isEmptyOfHumans(channel)) {
        await service.deleteTempChannel(guild, row.channel_id, "VoiceMaster: empty after restart");
        deleted++;
      }
    }
  }

  for (const cfg of store.allConfigs()) {
    const guild = client.guilds.cache.get(cfg.guild_id);
    const role = cfg.join_role_id && guild?.available && guild.roles.cache.get(cfg.join_role_id);
    if (!role) continue;
    for (const member of role.members.values()) {
      const now = member.voice.channelId;
      if (!now || (now !== cfg.hub_channel_id && !store.getChannel(guild.id, now)))
        await service.removeRole(member, role.id, "VoiceMaster: not in a voice channel");
    }
  }

  if (deleted || dropped) console.log(`[voicemaster] startup sweep: deleted ${deleted} empty channel(s), dropped ${dropped} stale row(s).`);
}

module.exports = function registerListeners() {
  listeners.on("voiceStateUpdate", { name: "voicemaster:voice" }, onVoiceStateUpdate);
  listeners.on("channelDelete", { name: "voicemaster:channelDelete" }, onChannelDelete);
  listeners.on("clientReady", { name: "voicemaster:sweep" }, (client) => sweep(client));
};

module.exports.sweep = sweep;
module.exports.onVoiceStateUpdate = onVoiceStateUpdate;
