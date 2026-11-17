/**
 * Guild tag ("server tag") rewards for /badge.
 *
 * Discord shows a user's chosen server tag next to their name. discord.js
 * 14.28 exposes it as `user.primaryGuild`:
 *   { identityGuildId, identityEnabled, tag, badge }   (or null)
 * A member "wears" this server's tag when identityGuildId is this guild and
 * identityEnabled is true (identityEnabled is false/null when they hid it).
 *
 * Detection, from fastest to slowest:
 *   - userUpdate: fires when a user's profile (incl. primary guild) changes
 *   - guildMemberUpdate: the member payload carries the user object too
 *   - a scheduler sweep every few hours per enabled guild, in case an event was
 *     missed (bot offline, or Discord not sending the update)
 * All three call reconcile(), which is idempotent: it compares what the user
 * wears with what we recorded in boosterrole_badge_members.
 */
const { access, guard, scheduler, script, ui } = require("../../core");
const store = require("./db");

const SWEEP_KIND = "boosterrole:badge-sweep";
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/** Default award message when none is set. */
const DEFAULT_SCRIPT = "{user.mention} is now wearing our **{tag}** tag. Thank you!";

/** True when `user` is displaying `guildId`'s tag. */
const wearsTag = (user, guildId) =>
  Boolean(user?.primaryGuild && user.primaryGuild.identityGuildId === guildId && user.primaryGuild.identityEnabled === true);

/** Extra script variables: {tag} and {tag.badge}. */
const tagVars = (user) => ({
  tag: user?.primaryGuild?.tag ?? "",
  "tag.badge": user?.guildTagBadgeURL?.() ?? "",
});

/** Adds or removes every badge role so it matches `wearing`. Returns how many changed. */
async function applyRoles(member, roleIds, wearing) {
  let changed = 0;
  for (const roleId of roleIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role || !guard.botCanManageRole(member.guild, role)) continue;
    const has = member.roles.cache.has(roleId);
    try {
      if (wearing && !has) await member.roles.add(role, "Wearing the server tag");
      else if (!wearing && has) await member.roles.remove(role, "No longer wearing the server tag");
      else continue;
      changed++;
    } catch (err) {
      console.warn(`[badge] ${member.guild.id}: role ${roleId} for ${member.id}: ${err.message}`);
    }
  }
  return changed;
}

/**
 * Brings one member in line with their tag.
 *   announce: post the award message when they newly adopt the tag
 *   force:    also remove roles from non-wearers we never recorded (used by sync)
 * Returns "added" | "removed" | null.
 */
async function reconcile(member, { announce = true, force = false } = {}) {
  if (!member || member.user?.bot) return null;
  const guild = member.guild;
  const cfg = store.badge.get(guild.id);
  if (!cfg.enabled) return null;

  const wearing = wearsTag(member.user, guild.id);
  const had = cfg.members.has(member.id);

  if (wearing) {
    await applyRoles(member, cfg.roleIds, true);
    if (had) return null;
    store.badge.setMember(guild.id, member.id, true);
    if (announce && cfg.channelId && !access.moduleDisabled(guild.id, "badge", null)) {
      const channel = guild.channels.cache.get(cfg.channelId);
      if (channel)
        await ui.safeSend(channel, script.render(cfg.script || DEFAULT_SCRIPT, { member, guild, channel, vars: tagVars(member.user) }));
    }
    return "added";
  }

  if (had || force) {
    const removed = await applyRoles(member, cfg.roleIds, false);
    if (had) store.badge.setMember(guild.id, member.id, false);
    return had || removed ? "removed" : null;
  }
  return null;
}

/**
 * Checks every member of a guild (fetches the full member list; needs the
 * GuildMembers intent). Returns { added, removed, wearing, scanned }.
 */
async function syncGuild(guild, { announce = false } = {}) {
  const members = await guild.members.fetch();
  const result = { added: 0, removed: 0, wearing: 0, scanned: 0 };
  // Members in our records who left the server: forget them.
  const cfg = store.badge.get(guild.id);
  for (const userId of [...cfg.members]) if (!members.has(userId)) store.badge.setMember(guild.id, userId, false);

  for (const member of members.values()) {
    if (member.user.bot) continue;
    result.scanned++;
    if (wearsTag(member.user, guild.id)) result.wearing++;
    const change = await reconcile(member, { announce, force: true });
    if (change === "added") result.added++;
    if (change === "removed") result.removed++;
  }
  return result;
}

/** (Re)starts the periodic fallback sweep for a guild. */
const scheduleSweep = (guildId, when = Date.now() + SWEEP_EVERY_MS) =>
  scheduler.schedule(SWEEP_KIND, when, { guildId }, { guildId, key: guildId });

scheduler.define(SWEEP_KIND, async (job, client) => {
  const guild = client.guilds.cache.get(job.payload.guildId);
  if (!guild || !store.badge.get(guild.id).enabled) return; // stop repeating
  // Missed adoptions do get their award message: they really are new.
  await syncGuild(guild, { announce: true });
  return Date.now() + SWEEP_EVERY_MS;
});

module.exports = { wearsTag, tagVars, reconcile, syncGuild, scheduleSweep, DEFAULT_SCRIPT, SWEEP_KIND };
