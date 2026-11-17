/**
 * VoiceMaster's Discord-side actions, shared by the slash command, the
 * interface panel (components.js) and the voice listener (listeners.js).
 *
 * Every owner action takes the acting member, finds the VoiceMaster channel
 * they are sitting in, checks they own it (by the stored owner, not by
 * Discord permissions), does the work and returns a short success text.
 * Problems are thrown as UserError so both commands and buttons show them.
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  OverwriteType,
  PermissionFlagsBits: P,
  Role,
  Routes,
  UserSelectMenuBuilder,
} = require("discord.js");
const { embeds, ensure, guard, parse, ui, UserError } = require("../../core");
const store = require("./db");
const logic = require("./logic");

/** Channel overwrite given to a temp channel's owner. */
const OWNER_PERMS = [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.ManageChannels, P.MoveMembers, P.MuteMembers];
const OWNER_OVERWRITE = { ViewChannel: true, Connect: true, Speak: true, Stream: true, ManageChannels: true, MoveMembers: true, MuteMembers: true };
/**
 * The bot keeps its own member overwrite so ghosting/locking a channel never
 * locks the bot out, and Speak so the music player still works with music mode on.
 */
const BOT_PERMS = [P.ViewChannel, P.Connect, P.Speak, P.ManageChannels, P.MoveMembers];
/** What the bot needs guild-wide to run VoiceMaster at all. */
const REQUIRED_BOT_PERMS = [P.ManageChannels, P.ManageRoles, P.MoveMembers, P.MuteMembers, P.ViewChannel, P.Connect];

/** Join-to-create cooldown (per guild+member) and rename limit (per channel). */
const createLimiter = new logic.RateLimiter(1, logic.CREATE_COOLDOWN_MS);
const renameLimiter = new logic.RateLimiter(logic.RENAME_LIMIT.max, logic.RENAME_LIMIT.windowMs);
/** Channels currently being deleted, so concurrent leave events don't double-delete. */
const deleting = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isCategory = (channel) => channel?.type === ChannelType.GuildCategory;

/** The role lock/ghost/music act on: /voicemaster default role, else @everyone. */
function defaultRole(guild) {
  const id = store.getConfig(guild.id)?.default_role_id;
  return (id && guild.roles.cache.get(id)) || guild.roles.everyone;
}

/** A configured category if it still exists, else null. */
function category(guild, id) {
  const channel = id ? guild.channels.cache.get(id) : null;
  return isCategory(channel) ? channel : null;
}

// ---------------------------------------------------------------- panel

const PANEL_ACTIONS = {
  lock: "🔒 Lock your channel",
  unlock: "🔓 Unlock your channel",
  ghost: "👻 Hide your channel",
  unghost: "👁️ Reveal your channel",
  claim: "👑 Claim a channel whose owner left",
  info: "ℹ️ Show channel info",
  limitup: "➕ Raise the member limit",
  limitdown: "➖ Lower the member limit",
  rename: "✏️ Rename your channel",
};

/** The interface panel: embed + persistent buttons/selects (custom ids "vm:<action>"). */
function buildPanel(client, guild) {
  const embed = new EmbedBuilder()
    .setColor(embeds.brand(client))
    .setTitle("VoiceMaster interface")
    .setDescription(
      [
        `Join ${store.getConfig(guild.id)?.hub_channel_id ? `<#${store.getConfig(guild.id).hub_channel_id}>` : "the Join to Create channel"} to get your own voice channel, then manage it here or with \`/voicemaster\`.`,
        "",
        ...Object.values(PANEL_ACTIONS),
        "👤 Use the menus to transfer ownership, reject or disconnect a member",
      ].join("\n")
    );
  const button = (id, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`vm:${id}`).setEmoji(emoji).setStyle(style);
  const userSelect = (id, placeholder) =>
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId(`vm:${id}`).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1)
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(button("lock", "🔒"), button("unlock", "🔓"), button("ghost", "👻"), button("unghost", "👁️"), button("claim", "👑", ButtonStyle.Primary)),
      new ActionRowBuilder().addComponents(button("info", "ℹ️"), button("limitup", "➕"), button("limitdown", "➖"), button("rename", "✏️")),
      userSelect("transfer", "Transfer ownership to…"),
      userSelect("reject", "Reject a member…"),
      userSelect("disconnect", "Disconnect a member…"),
    ],
  };
}

// ---------------------------------------------------------------- lookups

/**
 * The VoiceMaster channel the member is in, with its row.
 * `owner: true` (default) also requires the member to own it.
 */
function currentChannel(member, { owner = true } = {}) {
  const channel = member.voice?.channel;
  ensure(channel, "You need to be in your VoiceMaster voice channel to do that.");
  const row = store.getChannel(member.guild.id, channel.id);
  ensure(row, `${channel} isn't a VoiceMaster channel.`);
  if (owner) ensure(row.owner_id === member.id, `You don't own ${channel}. Its owner is <@${row.owner_id}>.`);
  return { channel, row };
}

// ---------------------------------------------------------------- roles

async function addRole(member, roleId, reason) {
  const role = roleId && member.guild.roles.cache.get(roleId);
  if (!role || member.roles.cache.has(role.id) || !guard.botCanManageRole(member.guild, role)) return;
  await member.roles.add(role, reason).catch((err) => console.warn(`[voicemaster] add role: ${err.message}`));
}

async function removeRole(member, roleId, reason) {
  const role = roleId && member.guild.roles.cache.get(roleId);
  if (!role || !member.roles.cache.has(role.id) || !guard.botCanManageRole(member.guild, role)) return;
  await member.roles.remove(role, reason).catch((err) => console.warn(`[voicemaster] remove role: ${err.message}`));
}

const humans = (channel) => [...(channel?.members?.values() ?? [])].filter((m) => !m.user.bot);

// ---------------------------------------------------------------- create / delete

/**
 * Join to create: makes a voice channel for `member` (who is in the hub),
 * moves them into it and records ownership. Returns the channel or null.
 */
async function createTempChannel(member, cfg) {
  const guild = member.guild;
  const me = guild.members.me;
  const parent = category(guild, cfg.public_category_id) ?? member.voice.channel?.parent ?? null;

  // Start from the category's overwrites (so the new channel behaves like its
  // siblings), then add the owner and the bot.
  const overwrites = new Map();
  for (const o of parent?.permissionOverwrites.cache.values() ?? [])
    overwrites.set(o.id, { id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield });
  overwrites.set(member.id, { id: member.id, type: OverwriteType.Member, allow: OWNER_PERMS });
  overwrites.set(me.id, { id: me.id, type: OverwriteType.Member, allow: BOT_PERMS });

  const options = {
    name: logic.renderName(cfg.default_name, member),
    type: ChannelType.GuildVoice,
    parent: parent?.id ?? null,
    permissionOverwrites: [...overwrites.values()],
    reason: `VoiceMaster: channel for ${member.user.tag}`,
  };
  if (cfg.default_bitrate) options.bitrate = logic.bitrateFor(cfg.default_bitrate, guild.maximumBitrate);
  if (cfg.default_region) options.rtcRegion = cfg.default_region;

  const channel = await guild.channels.create(options);
  // Record before moving, so the move's voice event already sees a VM channel.
  store.addChannel(guild.id, channel.id, member.id);

  try {
    await member.voice.setChannel(channel, "VoiceMaster: join to create");
  } catch {
    // They left the hub before we could move them: don't leave an empty channel behind.
    await deleteTempChannel(guild, channel.id, "VoiceMaster: creator left before being moved");
    return null;
  }
  if (cfg.default_interface) await ui.safeSend(channel, buildPanel(guild.client, guild));
  return channel;
}

/**
 * Deletes a temp channel and its row. Members still inside (only on reset)
 * lose the channel role and join role first, because once the row and config
 * are gone the leave event can no longer tell which roles to take back.
 */
async function deleteTempChannel(guild, channelId, reason = "VoiceMaster: channel empty") {
  if (deleting.has(channelId)) return;
  deleting.add(channelId);
  try {
    const row = store.getChannel(guild.id, channelId);
    const joinRoleId = store.getConfig(guild.id)?.join_role_id;
    const channel = guild.channels.cache.get(channelId);
    store.removeChannel(guild.id, channelId);
    if (!channel) return;

    for (const member of humans(channel)) {
      if (row?.role_id) await removeRole(member, row.role_id, reason);
      if (joinRoleId) await removeRole(member, joinRoleId, reason);
    }
    // If the music player is (alone) in here, stop it cleanly before the channel vanishes.
    if (guild.members.me?.voice.channelId === channelId) {
      try {
        guild.client.distube?.voices.leave(guild);
      } catch {
        /* no player */
      }
    }
    await channel.delete(reason).catch((err) => {
      if (err.code !== 10003) console.warn(`[voicemaster] couldn't delete #${channel.name}: ${err.message}`);
    });
  } finally {
    deleting.delete(channelId);
  }
}

// ---------------------------------------------------------------- owner actions

async function lock(member) {
  const { channel } = currentChannel(member);
  await channel.permissionOverwrites.edit(defaultRole(member.guild), { Connect: false }, { reason: "VoiceMaster: lock" });
  store.updateChannel(member.guild.id, channel.id, { locked: 1 });
  return `${channel} is now **locked**.`;
}

async function unlock(member) {
  const { channel } = currentChannel(member);
  // null = remove our deny and fall back to the server's normal permission.
  await channel.permissionOverwrites.edit(defaultRole(member.guild), { Connect: null }, { reason: "VoiceMaster: unlock" });
  store.updateChannel(member.guild.id, channel.id, { locked: 0 });
  return `${channel} is now **unlocked**.`;
}

async function ghost(member) {
  guard.assert(member, "Tier 2 Only");
  const { channel } = currentChannel(member);
  await channel.permissionOverwrites.edit(defaultRole(member.guild), { ViewChannel: false }, { reason: "VoiceMaster: ghost" });
  const privateCategory = category(member.guild, store.getConfig(member.guild.id)?.private_category_id);
  if (privateCategory && channel.parentId !== privateCategory.id)
    await channel.setParent(privateCategory, { lockPermissions: false, reason: "VoiceMaster: ghost" });
  store.updateChannel(member.guild.id, channel.id, { ghosted: 1 });
  return `${channel} is now **hidden** from everyone else.`;
}

async function unghost(member) {
  guard.assert(member, "Tier 2 Only");
  const { channel } = currentChannel(member);
  await channel.permissionOverwrites.edit(defaultRole(member.guild), { ViewChannel: null }, { reason: "VoiceMaster: unghost" });
  const publicCategory = category(member.guild, store.getConfig(member.guild.id)?.public_category_id);
  if (publicCategory && channel.parentId !== publicCategory.id)
    await channel.setParent(publicCategory, { lockPermissions: false, reason: "VoiceMaster: unghost" });
  store.updateChannel(member.guild.id, channel.id, { ghosted: 0 });
  return `${channel} is **visible** again.`;
}

/**
 * Discord allows 2 renames per channel per 10 minutes, and discord.js would
 * silently queue a third for up to 10 minutes. So we count renames ourselves
 * and refuse early; if Discord is still slow (renamed in the Discord UI too),
 * we stop waiting after a few seconds and say so.
 */
async function rename(member, rawName) {
  const { channel } = currentChannel(member);
  const name = String(rawName ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  ensure(name, "The name can't be empty.");
  const wait = renameLimiter.take(channel.id);
  if (wait)
    throw new UserError(`Discord only allows **2 renames per 10 minutes** per channel. Try again ${parse.timestamp(new Date(Date.now() + wait), "R")}.`);
  let outcome;
  try {
    outcome = await Promise.race([channel.setName(name, "VoiceMaster: rename").then(() => "done"), sleep(5000).then(() => "slow")]);
  } catch (err) {
    renameLimiter.undo(channel.id);
    throw err;
  }
  return outcome === "done"
    ? `Renamed your channel to **${name}**.`
    : `Discord is rate-limiting renames for ${channel}; it will become **${name}** as soon as Discord allows it.`;
}

async function setStatus(member, rawStatus) {
  const { channel } = currentChannel(member);
  const status = String(rawStatus ?? "").trim();
  const clear = !status || ["clear", "none", "reset"].includes(status.toLowerCase());
  // discord.js has no helper for voice channel status yet, so call the REST route.
  await member.client.rest.put(Routes.channelVoiceStatus(channel.id), { body: { status: clear ? "" : status.slice(0, 500) } });
  return clear ? `Cleared the status of ${channel}.` : `Set the status of ${channel} to **${status.slice(0, 500)}**.`;
}

async function setLimit(member, limit) {
  const { channel } = currentChannel(member);
  ensure(Number.isInteger(limit) && limit >= 0 && limit <= 99, "The limit must be between 0 (unlimited) and 99.");
  await channel.setUserLimit(limit, "VoiceMaster: limit");
  return limit ? `${channel} now allows **${limit}** member${limit === 1 ? "" : "s"}.` : `${channel} no longer has a member limit.`;
}

const stepLimit = (member, delta) => {
  const { channel } = currentChannel(member);
  return setLimit(member, logic.stepLimit(channel.userLimit, delta));
};

async function setBitrate(member, kbps) {
  const { channel } = currentChannel(member);
  const max = Math.floor(member.guild.maximumBitrate / 1000);
  ensure(kbps >= 8 && kbps <= max, `The bitrate must be between 8 and **${max}** kbps on this server (boosting raises the maximum).`);
  await channel.setBitrate(logic.bitrateFor(kbps, member.guild.maximumBitrate), "VoiceMaster: bitrate");
  return `${channel} now uses **${kbps} kbps**.`;
}

async function setMusic(member, enabled) {
  const { channel } = currentChannel(member);
  // The owner's and the bot's own member overwrites allow Speak, so only they can talk.
  await channel.permissionOverwrites.edit(defaultRole(member.guild), { Speak: enabled ? false : null }, { reason: "VoiceMaster: music mode" });
  store.updateChannel(member.guild.id, channel.id, { music: enabled ? 1 : 0 });
  return enabled
    ? `Music mode **on**: only you (and the music bot) can speak in ${channel}. People already inside may need to rejoin.`
    : `Music mode **off**: everyone can speak in ${channel} again.`;
}

/** /voicemaster role: the role is given to everyone in the channel. Same role again turns it off. */
async function setRole(member, role) {
  const { channel, row } = currentChannel(member);
  if (row.role_id === role.id) {
    for (const m of humans(channel)) await removeRole(m, role.id, "VoiceMaster: channel role removed");
    store.updateChannel(member.guild.id, channel.id, { role_id: null });
    return `${role} is no longer given in ${channel}.`;
  }
  guard.assertManageableRole(member, role);
  for (const m of humans(channel)) {
    if (row.role_id) await removeRole(m, row.role_id, "VoiceMaster: channel role changed");
    await addRole(m, role.id, "VoiceMaster: channel role");
  }
  store.updateChannel(member.guild.id, channel.id, { role_id: role.id });
  return `Everyone in ${channel} now gets ${role} (removed when they leave). Run it again with the same role to turn it off.`;
}

const isRole = (target) => target instanceof Role;

async function permit(member, target) {
  const { channel } = currentChannel(member);
  ensure(target, "Pick a member or role.");
  await channel.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true }, { reason: "VoiceMaster: permit" });
  return `${target} can now join ${channel}.`;
}

async function reject(member, target) {
  const { channel, row } = currentChannel(member);
  ensure(target, "Pick a member or role.");
  ensure(target.id !== row.owner_id, "You can't reject yourself.");
  ensure(target.id !== member.client.user.id, "You can't reject me.");
  ensure(target.id !== member.guild.id, "To keep everyone out, use `/voicemaster lock` instead.");
  await channel.permissionOverwrites.edit(target, { Connect: false }, { reason: "VoiceMaster: reject" });

  // Kick out whoever the rejection covers (never the owner or bots).
  const covered = humans(channel).filter((m) => m.id !== row.owner_id && (isRole(target) ? m.roles.cache.has(target.id) : m.id === target.id));
  for (const m of covered) await m.voice.disconnect("VoiceMaster: rejected").catch(() => {});
  return `${target} can no longer join ${channel}.${covered.length ? ` Disconnected ${covered.length} member${covered.length === 1 ? "" : "s"}.` : ""}`;
}

/** Panel only: disconnect someone from your channel. */
async function disconnect(member, target) {
  const { channel } = currentChannel(member);
  ensure(target && target.voice?.channelId === channel.id, "That member isn't in your channel.");
  ensure(target.id !== member.id, "Just leave the channel to disconnect yourself.");
  await target.voice.disconnect("VoiceMaster: disconnected by owner");
  return `Disconnected ${target} from ${channel}.`;
}

/** Moves the owner overwrite and the stored owner to `newOwner`. */
async function changeOwner(channel, oldOwnerId, newOwner, reason) {
  await channel.permissionOverwrites.delete(oldOwnerId, reason).catch(() => {});
  await channel.permissionOverwrites.edit(newOwner, OWNER_OVERWRITE, { reason });
  store.updateChannel(channel.guild.id, channel.id, { owner_id: newOwner.id });
}

async function claim(member) {
  const { channel, row } = currentChannel(member, { owner: false });
  ensure(row.owner_id !== member.id, "You already own this channel.");
  ensure(!channel.members.has(row.owner_id), `<@${row.owner_id}> is still in ${channel}; you can only claim it once they leave.`);
  await changeOwner(channel, row.owner_id, member, "VoiceMaster: claim");
  return `You now own ${channel}.`;
}

async function transfer(member, target) {
  const { channel } = currentChannel(member);
  ensure(target, "That member isn't in this server.");
  ensure(target.id !== member.id, "You already own this channel.");
  ensure(!target.user.bot, "Bots can't own a voice channel.");
  ensure(target.voice?.channelId === channel.id, `${target} needs to be in ${channel} to receive it.`);
  await changeOwner(channel, member.id, target, "VoiceMaster: transfer");
  return `${target} now owns ${channel}.`;
}

/** /voicemaster info and the panel's ℹ️ button. Anyone inside the channel may look. */
function infoEmbed(member) {
  const { channel, row } = currentChannel(member, { owner: false });
  const yes = logic.yesNo;
  return new EmbedBuilder()
    .setColor(embeds.brand(member.client))
    .setTitle(channel.name)
    .addFields(
      { name: "Owner", value: `<@${row.owner_id}>`, inline: true },
      { name: "Created", value: parse.timestamp(new Date(row.created_at), "R"), inline: true },
      { name: "Members", value: `${channel.members.size}${channel.userLimit ? `/${channel.userLimit}` : ""}`, inline: true },
      { name: "Locked", value: yes(row.locked), inline: true },
      { name: "Hidden", value: yes(row.ghosted), inline: true },
      { name: "Music mode", value: yes(row.music), inline: true },
      { name: "Bitrate", value: `${Math.round(channel.bitrate / 1000)} kbps`, inline: true },
      { name: "Region", value: channel.rtcRegion ?? "Automatic", inline: true },
      { name: "Channel role", value: row.role_id ? `<@&${row.role_id}>` : "None", inline: true }
    );
}

module.exports = {
  REQUIRED_BOT_PERMS,
  createLimiter,
  renameLimiter,
  buildPanel,
  currentChannel,
  addRole,
  removeRole,
  humans,
  category,
  createTempChannel,
  deleteTempChannel,
  lock,
  unlock,
  ghost,
  unghost,
  rename,
  setStatus,
  setLimit,
  stepLimit,
  setBitrate,
  setMusic,
  setRole,
  permit,
  reject,
  disconnect,
  claim,
  transfer,
  infoEmbed,
};
