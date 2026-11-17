/**
 * Discord-side levelling actions shared by the listener and the commands:
 * giving level roles and announcing level-ups.
 */
const { guard, script, ui } = require("../../core");
const store = require("./db");
const { planLevelRoles, progress } = require("./formula");

/**
 * Gives / removes level roles so `member` matches `level` (stack or replace
 * per the guild setting). Roles the bot can't manage are skipped silently.
 * @returns {Promise<{ added: string[], removed: string[] }>}
 */
async function applyLevelRoles(member, level, settings = store.settings.get(member.guild.id), reason = "Level roles") {
  if (!settings.roles.length) return { added: [], removed: [] };
  const guild = member.guild;
  const plan = planLevelRoles(settings.roles, level, settings.stackRoles, new Set(member.roles.cache.keys()));
  const manageable = (id) => guard.botCanManageRole(guild, guild.roles.cache.get(id));
  const added = plan.add.filter(manageable);
  const removed = plan.remove.filter(manageable);
  if (added.length) await member.roles.add(added, reason);
  if (removed.length) await member.roles.remove(removed, reason);
  return { added, removed };
}

/** Variables the level-up script can use, on top of the core {user…} {guild…} ones. */
const LEVEL_VARIABLES = {
  "{level}": "The new level",
  "{xp}": "The member's total XP",
  "{next_level}": "The level after this one",
  "{next_xp}": "Total XP needed for the next level",
  "{rank}": "The member's position on the server leaderboard",
  "{role}": "The level role just awarded (empty if none)",
};

/** Builds the {level} {xp} {next_level} {next_xp} {rank} {role} values. */
function levelVars(guildId, xp, roleId) {
  const p = progress(xp);
  return {
    level: p.level,
    xp: p.xp.toLocaleString("en-US"),
    next_level: p.nextLevel,
    next_xp: p.nextXp.toLocaleString("en-US"),
    rank: store.rankOf(guildId, p.xp),
    role: roleId ? `<@&${roleId}>` : "",
  };
}

/**
 * Sends the level-up message according to /levels messagemode. Never throws
 * for Discord failures (missing permissions, closed DMs).
 */
async function announceLevelUp({ member, channel, xp, roleId, settings, optOut }) {
  if (optOut || settings.messageMode === "off") return null;
  const ctx = { member, guild: member.guild, vars: levelVars(member.guild.id, xp, roleId) };

  try {
    if (settings.messageMode === "dm") {
      return await member.send(script.render(settings.script, { ...ctx, channel })).catch(() => null);
    }
    const target = settings.messageMode === "channel" ? member.guild.channels.cache.get(settings.messageChannelId) : channel;
    if (!target) return null;
    return await ui.safeSend(target, script.render(settings.script, { ...ctx, channel: target }));
  } catch (err) {
    // A stored script that no longer renders (e.g. a bad colour) must not break XP.
    console.warn(`[levels] level-up message in ${member.guild.id} failed: ${err.message}`);
    return null;
  }
}

module.exports = { applyLevelRoles, announceLevelUp, levelVars, LEVEL_VARIABLES };
