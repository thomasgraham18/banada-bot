/**
 * Levels listeners.
 *
 * messageCreate is the hot path: everything it reads comes from the
 * guildCache (store.settings) and an in-memory cooldown map, and an awarded
 * message costs exactly one UPSERT. A second write happens only on level-up.
 */
const { listeners } = require("../../core");
const store = require("./db");
const { COOLDOWN_MS, levelForXp, rollXp } = require("./formula");
const { applyLevelRoles, announceLevelUp } = require("./service");

/** `${guildId}:${userId}` -> last time XP was awarded (ms). */
const cooldowns = new Map();

/** Keeps the cooldown map from growing forever on big servers. */
function pruneCooldowns(now) {
  if (cooldowns.size < 10_000) return;
  for (const [key, at] of cooldowns) if (now - at >= COOLDOWN_MS) cooldowns.delete(key);
}

/** True when the message's channel, its parent channel or its category is ignored. */
function channelIgnored(settings, channel) {
  if (!settings.ignoredChannels.size || !channel) return false;
  return [channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && settings.ignoredChannels.has(id));
}

function hasIgnoredRole(settings, member) {
  if (!settings.ignoredRoles.size) return false;
  for (const id of settings.ignoredRoles) if (member.roles.cache.has(id)) return true;
  return false;
}

async function onMessage(client, message) {
  if (!message.inGuild() || message.author.bot || message.system || message.webhookId) return;
  const guildId = message.guildId;
  const settings = store.settings.get(guildId);
  if (!settings.enabled) return;
  if (channelIgnored(settings, message.channel)) return;
  const member = message.member;
  if (!member || hasIgnoredRole(settings, member)) return;

  const now = Date.now();
  const key = `${guildId}:${member.id}`;
  if (now - (cooldowns.get(key) ?? 0) < COOLDOWN_MS) return;
  cooldowns.set(key, now);
  pruneCooldowns(now);

  const row = store.awardXp(guildId, member.id, rollXp(settings.multiplier), now);
  const level = levelForXp(row.xp);
  if (level === row.level) return;
  store.storeLevel(guildId, member.id, level);
  if (level < row.level) return; // only possible if the curve changed; just resync the stored level

  let awarded = null;
  try {
    const { added } = await applyLevelRoles(member, level, settings, `Reached level ${level}`);
    // {role} = the role for the highest level crossed by this message, if it was just given.
    const crossed = settings.roles.filter((r) => r.level > row.level && r.level <= level).at(-1);
    awarded = crossed && added.includes(crossed.roleId) ? crossed.roleId : null;
  } catch (err) {
    console.warn(`[levels] could not update level roles for ${member.id} in ${guildId}: ${err.message}`);
  }
  await announceLevelUp({ member, channel: message.channel, xp: row.xp, roleId: awarded, settings, optOut: Boolean(row.messages_opt_out) });
}

/** Gives returning members their level roles back. */
async function onMemberAdd(client, member) {
  const settings = store.settings.get(member.guild.id);
  if (!settings.enabled || !settings.roles.length || member.user.bot) return;
  const level = store.getLevel(member.guild.id, member.id);
  if (level > 0) await applyLevelRoles(member, level, settings, "Level roles restored on rejoin");
}

/** A deleted role can't be awarded any more: drop it from the config. */
function onRoleDelete(client, role) {
  const settings = store.settings.get(role.guild.id);
  if (settings.roles.some((r) => r.roleId === role.id) || settings.ignoredRoles.has(role.id)) store.forgetRole(role.guild.id, role.id);
}

module.exports = function setup() {
  listeners.on("messageCreate", { name: "levels:xp", module: "levels", event: "levels_xp" }, onMessage);
  listeners.on("guildMemberAdd", { name: "levels:rejoin", module: "levels" }, onMemberAdd);
  listeners.on("roleDelete", { name: "levels:role-delete" }, onRoleDelete);
};

module.exports.cooldowns = cooldowns;
module.exports.onMessage = onMessage;
