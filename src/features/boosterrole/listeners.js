/**
 * Listeners for booster roles and guild tag rewards. Everything on the hot
 * path reads the guildCaches in ./db (no DB query per event).
 *
 *   guildMemberUpdate  boost started / ended -> award role, booster role grace period
 *                      user object changed  -> guild tag reward (badge)
 *   userUpdate         primary guild (tag) changed -> guild tag reward
 *   guildMemberRemove  owner left -> grace period; shares + badge record dropped
 *   roleDelete         forget deleted booster / award / badge roles
 *   clientReady        make sure every enabled guild has its badge sweep scheduled
 */
const { access, listeners, scheduler } = require("../../core");
const store = require("./db");
const br = require("./roles");
const badge = require("./badge");

/** True if a grace-period job is already pending (so we don't keep postponing it). */
const expiryPending = (guildId, userId) =>
  scheduler.list(br.EXPIRE_KIND, guildId).some((j) => j.key === `${guildId}:${userId}`);

module.exports = function setupListeners() {
  // ---------------------------------------------------------------- boosting
  listeners.on("guildMemberUpdate", { name: "boosterrole:boost", module: "boosterrole" }, async (client, oldMember, newMember) => {
    const guildId = newMember.guild.id;
    // A partial old member means we don't know the previous state: reconcile anyway.
    const known = !oldMember.partial;
    const was = Boolean(oldMember.premiumSince);
    const now = Boolean(newMember.premiumSince);
    if (!known || was !== now) await br.syncAward(newMember);

    if (!store.roles.byOwner(guildId, newMember.id)) return;
    if (br.isBoosting(newMember)) {
      if (!known || !was) br.cancelExpiry(guildId, newMember.id);
    } else if ((!known || was) && !expiryPending(guildId, newMember.id)) {
      br.scheduleExpiry(guildId, newMember.id);
    }
  });

  // ---------------------------------------------------------------- guild tag
  listeners.on("guildMemberUpdate", { name: "boosterrole:badge", module: "badge" }, async (client, oldMember, newMember) => {
    if (!store.badge.get(newMember.guild.id).enabled) return;
    await badge.reconcile(newMember);
  });

  // userUpdate has no guild, so the module check is done per guild here.
  listeners.on("userUpdate", { name: "boosterrole:badge-user" }, async (client, oldUser, newUser) => {
    if (newUser.bot) return;
    const guildIds = new Set([oldUser.primaryGuild?.identityGuildId, newUser.primaryGuild?.identityGuildId].filter(Boolean));
    for (const guildId of guildIds) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild || !store.badge.get(guildId).enabled || access.moduleDisabled(guildId, "badge", null)) continue;
      const member = guild.members.cache.get(newUser.id) ?? (await guild.members.fetch(newUser.id).catch(() => null));
      if (member) await badge.reconcile(member);
    }
  });

  // ---------------------------------------------------------------- leaving / deleted roles
  listeners.on("guildMemberRemove", { name: "boosterrole:leave" }, async (client, member) => {
    const guildId = member.guild.id;
    store.shares.removeMember(guildId, member.id);
    if (store.badge.get(guildId).members.has(member.id)) store.badge.setMember(guildId, member.id, false);
    // Deleted after the grace period unless they come back boosting.
    if (store.roles.byOwner(guildId, member.id) && !expiryPending(guildId, member.id)) br.scheduleExpiry(guildId, member.id);
  });

  listeners.on("roleDelete", { name: "boosterrole:role-delete" }, async (client, role) => {
    const guildId = role.guild.id;
    if (store.roles.ownerOf(guildId, role.id)) {
      const ownerId = store.roles.ownerOf(guildId, role.id);
      br.cancelExpiry(guildId, ownerId);
      store.roles.removeRole(guildId, role.id);
    }
    if (store.boosterCache.get(guildId).awardRoleId === role.id) store.settings.set(guildId, "award_role_id", null);
    if (store.badge.get(guildId).roleIds.includes(role.id)) store.badge.removeRole(guildId, role.id);
  });

  // ---------------------------------------------------------------- startup
  listeners.on("clientReady", { name: "boosterrole:ready" }, async (client) => {
    // The sweep reschedules itself, but a job dropped after repeated failures
    // (e.g. a long outage) would stop it; re-arm any enabled guild without one.
    const pending = new Set(scheduler.list(badge.SWEEP_KIND).map((j) => j.key));
    for (const guildId of store.badge.enabledGuilds())
      if (!pending.has(guildId) && client.guilds.cache.has(guildId)) badge.scheduleSweep(guildId, Date.now() + 60_000);
  });
};
