/**
 * Discord-side booster role operations shared by the commands and listeners:
 * colours (solid / gradient / holographic), creating + positioning the role,
 * deleting it, and the "boost lost" grace period.
 */
const { GuildFeature, Constants, PermissionFlagsBits: P } = require("discord.js");
const { config, guard, scheduler, UserError } = require("../../core");
const store = require("./db");
const { findBlockedWord, cleanRoleName } = require("./colour");

/** How long a member keeps their booster role after their boost ends. */
const GRACE_MS = 24 * 60 * 60 * 1000;
const EXPIRE_KIND = "boosterrole:expire";
const DISCORD_ROLE_CAP = 250;

/** Boosting, or the server owner (the "Booster Only" gate lets the owner through too). */
const isBoosting = (member) => Boolean(member?.premiumSince) || guard.isOwner(member);

const hasFeature = (guild, feature) => Boolean(guild.features?.includes(feature));

/**
 * The `colors` object for role.create/edit, limited to what the server
 * supports. Returns { colors, note } where note explains any downgrade.
 *   holo: true -> Discord's holographic style (exact constants required)
 */
function buildColours(guild, primary, secondary = null, { holo = false } = {}) {
  const gradients = hasFeature(guild, GuildFeature.EnhancedRoleColors);
  if (holo) {
    if (!gradients) throw new UserError("Holographic roles need the server's **Enhanced Role Styles** perk (boost level 2+).");
    const h = Constants.HolographicStyle;
    return { colors: { primaryColor: h.Primary, secondaryColor: h.Secondary, tertiaryColor: h.Tertiary }, note: null };
  }
  if (secondary != null && !gradients)
    return {
      colors: { primaryColor: primary, secondaryColor: null, tertiaryColor: null },
      note: "This server doesn't have **Enhanced Role Styles**, so I used a solid colour (the first one).",
    };
  return { colors: { primaryColor: primary, secondaryColor: secondary ?? null, tertiaryColor: null }, note: null };
}

/** Throws a readable error unless the bot can edit/assign `role`. */
function assertBotCanEdit(guild, role) {
  guard.assertBotPermissions(guild, [P.ManageRoles]);
  if (!guard.botCanManageRole(guild, role))
    throw new UserError(`I can't manage ${role}: it is managed or above my highest role. Move my role above it.`);
}

/**
 * The Role registered for `ownerId`, or null. A registered role that no longer
 * exists in Discord is forgotten on the spot.
 */
async function ownedRole(guild, ownerId) {
  const roleId = store.roles.byOwner(guild.id, ownerId);
  if (!roleId) return null;
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    store.roles.removeRole(guild.id, roleId);
    return null;
  }
  return role;
}

async function requireOwnedRole(guild, ownerId) {
  const role = await ownedRole(guild, ownerId);
  if (!role) throw new UserError("You don't have a booster role yet. Create one with `/boosterrole color`.");
  return role;
}

/** Throws if `name` contains a blacklisted word. */
function assertNameAllowed(guildId, name) {
  const word = findBlockedWord(name, store.filter.list(guildId));
  if (word) throw new UserError("That name contains a word that isn't allowed in booster role names.");
}

/** The base role (config.KEYS.BASE_ROLE), or null if unset / deleted. */
function baseRole(guild) {
  const id = config.get(guild.id, config.KEYS.BASE_ROLE);
  return id ? guild.roles.cache.get(id) ?? null : null;
}

/**
 * Moves `role` directly below the base role (never above the bot's own top
 * role, which Discord would refuse). Returns a note if it couldn't.
 *
 * Positions: Discord numbers roles bottom-up. Moving a role that sits below
 * the base role to `base.position - 1` puts it right under the base role
 * (the roles in between each shift down by one).
 */
async function positionBelowBase(guild, role) {
  const base = baseRole(guild);
  if (!base) return "No base role is set, so the role sits at the bottom of the list (its colour may be hidden by other roles). An admin can fix this with `/boosterrole base`.";
  await guild.roles.fetch(); // fresh positions: creating a role shifts everything
  const me = guild.members.me;
  const target = Math.max(1, Math.min(base.position - (role.position < base.position ? 1 : 0), me.roles.highest.position - 1));
  if (role.position === target) return null;
  try {
    await guild.roles.setPositions([{ role: role.id, position: target }]);
    return null;
  } catch (err) {
    return `I couldn't move the role under ${base} (${err.message}).`;
  }
}

/**
 * Creates the member's booster role, or updates it when they already have
 * one. `style` is passed to role.create/edit ({ colors }, icon ...).
 * Returns { role, created, notes[] }.
 */
async function createOrUpdate(member, { name, style }) {
  const guild = member.guild;
  const notes = [];
  guard.assertBotPermissions(guild, [P.ManageRoles]);
  if (name) assertNameAllowed(guild.id, name);

  let role = await ownedRole(guild, member.id);
  if (role) {
    assertBotCanEdit(guild, role);
    role = await role.edit({ ...style, ...(name ? { name } : {}), reason: `Booster role of ${member.user.tag}` });
    if (!member.roles.cache.has(role.id)) await member.roles.add(role, "Booster role");
    return { role, created: false, notes };
  }

  // New role: server-wide limit, then Discord's cap.
  const limit = store.settings.get(guild.id).role_limit;
  if (limit != null && store.roles.count(guild.id) >= limit)
    throw new UserError(`This server has reached its limit of **${limit}** booster roles.`);
  if (guild.roles.cache.size >= DISCORD_ROLE_CAP) throw new UserError("This server has reached Discord's limit of 250 roles.");

  const roleName = cleanRoleName(name || member.displayName) || "Booster";
  if (!name) assertNameAllowed(guild.id, roleName);
  role = await guild.roles.create({
    name: roleName,
    permissions: [], // booster roles are cosmetic only
    mentionable: false,
    reason: `Booster role of ${member.user.tag}`,
    ...style,
  });
  store.roles.set(guild.id, member.id, role.id);
  const note = await positionBelowBase(guild, role);
  if (note) notes.push(note);
  await member.roles.add(role, "Booster role");
  return { role, created: true, notes };
}

/** Deletes a booster role in Discord (if allowed) and forgets it. */
async function deleteBoosterRole(guild, roleId, reason) {
  const ownerId = store.roles.ownerOf(guild.id, roleId);
  if (ownerId) cancelExpiry(guild.id, ownerId);
  store.roles.removeRole(guild.id, roleId);
  const role = guild.roles.cache.get(roleId);
  if (role && guard.botCanManageRole(guild, role)) await role.delete(reason).catch(() => {});
}

// ---------------------------------------------------------------- boost lost / regained

/** Starts the grace period after which the member's booster role is deleted. */
const scheduleExpiry = (guildId, userId) =>
  scheduler.schedule(EXPIRE_KIND, Date.now() + GRACE_MS, { guildId, userId }, { guildId, key: `${guildId}:${userId}` });

const cancelExpiry = (guildId, userId) => scheduler.cancel(EXPIRE_KIND, `${guildId}:${userId}`);

scheduler.define(EXPIRE_KIND, async (job, client) => {
  const { guildId, userId } = job.payload;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return; // bot left the server
  const roleId = store.roles.byOwner(guildId, userId);
  if (!roleId) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member && isBoosting(member)) return; // boosted again in time
  await deleteBoosterRole(guild, roleId, "Booster role owner stopped boosting");
});

/** Gives / takes the award role to match the member's boosting state. */
async function syncAward(member) {
  const awardId = store.boosterCache.get(member.guild.id).awardRoleId;
  if (!awardId) return;
  const role = member.guild.roles.cache.get(awardId);
  if (!role || !guard.botCanManageRole(member.guild, role)) return;
  const boosting = Boolean(member.premiumSince);
  if (boosting && !member.roles.cache.has(role.id)) await member.roles.add(role, "Boost award role");
  else if (!boosting && member.roles.cache.has(role.id)) await member.roles.remove(role, "Boost ended");
}

module.exports = {
  GRACE_MS,
  EXPIRE_KIND,
  isBoosting,
  hasFeature,
  buildColours,
  assertBotCanEdit,
  ownedRole,
  requireOwnedRole,
  assertNameAllowed,
  baseRole,
  positionBelowBase,
  createOrUpdate,
  deleteBoosterRole,
  scheduleExpiry,
  cancelExpiry,
  syncAward,
};
