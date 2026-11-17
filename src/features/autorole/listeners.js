/**
 * Listeners and persistent components for /autorole.
 *
 *   guildMemberAdd / guildMemberUpdate   join roles (+ restored reaction roles),
 *                                        waiting for membership screening
 *   messageReactionAdd / Remove          reaction roles
 *   "role:b:<roleId>" buttons            button roles (toggle)
 *   "role:d" select menu                 dropdown roles
 *   roleDelete / messageDelete           forget rows that point at nothing
 *
 * The reaction listeners only act on message IDs in OUR tables (checked
 * first, from the cache). The web-panel reaction-role board in
 * utils/reactionRoles.js handles its own messages separately.
 */
const { MessageFlags, GuildFeature } = require("discord.js");
const { listeners, components, guard, parse, embeds, UserError } = require("../../core");
const store = require("./db");
const { PREFIX, meetsRequired, dropdownChanges } = require("./logic");
const { applyRoles, redraw, rowsFor } = require("./menus");

const DAY = 24 * 60 * 60 * 1000;
const mentions = (ids) => ids.map((id) => `<@&${id}>`).join(", ");

// ---------------------------------------------------------------- join roles

/** Gives a new (screened) member the join roles and, if enabled, their old reaction roles. */
async function giveJoinRoles(member) {
  if (member.user.bot) return; // bots skip autoroles (they usually get their own managed role)
  const guildId = member.guild.id;
  const s = store.state.get(guildId);
  const roles = new Set(s.join);

  if (store.reaction.restoreEnabled(guildId)) {
    // Only roles that are still reaction roles somewhere in this server.
    const reactionRoles = new Set([...s.reactions.values()].flatMap((m) => [...m.values()]));
    for (const id of store.reaction.history(guildId, member.id)) if (reactionRoles.has(id)) roles.add(id);
  }

  const add = [...roles].filter((id) => !member.roles.cache.has(id));
  if (add.length) await applyRoles(member, { add }, "Autorole on join");
}

// ---------------------------------------------------------------- reactions

/** Recent reaction-role events, newest first (shown on the web panel's Activity tab). */
const activity = [];
function logActivity(text) {
  activity.unshift({ time: Date.now(), text });
  activity.length = Math.min(activity.length, 100);
}

/*
 * When the bot takes a member's reaction off (not allowed, stray emoji,
 * exclusive swap), Discord sends a "reaction removed" event for it. That must
 * NOT be treated as the member un-picking a role, or the bot could take away
 * a role they're entitled to. Removals the bot makes are remembered here for
 * a short time and skipped by the listener.
 */
const botRemovals = new Set();
async function removeReactionAsBot(reactionOrMessage, emojiKey, userId) {
  const reaction = reactionOrMessage.users ? reactionOrMessage
    : reactionOrMessage.reactions?.cache.find((r) => parse.emojiKey(r.emoji) === emojiKey);
  if (!reaction) return;
  const messageId = reaction.message.id;
  const key = `${messageId}:${userId}:${emojiKey ?? parse.emojiKey(reaction.emoji)}`;
  botRemovals.add(key);
  setTimeout(() => botRemovals.delete(key), 30_000).unref?.();
  await reaction.users.remove(userId).catch(() => botRemovals.delete(key));
}

const warned = new Map(); // roleId -> time of last warning
function warnUnmanageable(guild, role, roleId, user) {
  const last = warned.get(roleId) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  warned.set(roleId, Date.now());
  const why = !role ? "the role no longer exists"
    : !guild.members.me?.permissions.has("ManageRoles") ? "I don't have the Manage Roles permission"
    : role.managed ? "it's managed by an integration"
    : `it's above my highest role (@${guild.members.me?.roles.highest.name}). Move my role above it in Server Settings → Roles`;
  const text = `Can't give @${role?.name ?? roleId} to ${user.tag ?? user.id} in ${guild.name}: ${why}.`;
  logActivity(text);
  console.warn(`[autorole] ${text}`);
}

/** One reaction at a time per member, so quick clicks can't interleave. */
const queues = new Map();
function perMember(userId, task) {
  const next = (queues.get(userId) ?? Promise.resolve()).then(task).catch((err) => console.error("[autorole] reaction failed:", err));
  queues.set(userId, next);
  next.finally(() => queues.get(userId) === next && queues.delete(userId));
  return next;
}

/** In an exclusive group: removes the member's other roles (and reactions) from that group. */
async function dropOtherGroupRoles(guild, member, s, group, keepRoleId) {
  for (const messageId of s.groupMessages.get(group.group_name) ?? []) {
    const map = s.reactions.get(messageId);
    if (!map) continue;
    const held = [...map].filter(([, roleId]) => roleId !== keepRoleId && member.roles.cache.has(roleId));
    if (!held.length) continue;
    const roles = held.map(([, id]) => guild.roles.cache.get(id)).filter((r) => guard.botCanManageRole(guild, r));
    if (roles.length) await member.roles.remove(roles, "Reaction role swapped");
    for (const [, id] of held) store.reaction.forget(guild.id, member.id, id);

    const channel = guild.channels.cache.get(s.channels.get(messageId));
    const message = await channel?.messages?.fetch(messageId).catch(() => null);
    for (const [emojiKey] of held) if (message) await removeReactionAsBot(message, emojiKey, member.id);
  }
}

async function onReaction(client, reaction, user, added) {
  const message = reaction.message;
  const guildId = message.guildId;
  if (!guildId || user.id === client.user.id) return;
  // Cheap cache lookups first: most reactions are on messages we don't own.
  const s = store.state.get(guildId);
  const roles = s.reactions.get(message.id);
  const group = s.groups.get(message.id);
  if (!roles && !group) return;
  const emojiKey = parse.emojiKey(reaction.emoji);

  if (!added && botRemovals.delete(`${message.id}:${user.id}:${emojiKey}`)) return; // our own removal

  return perMember(user.id, async () => {
    const roleId = roles?.get(emojiKey);
    if (!roleId) {
      // Not an option on this menu.
      if (added && group?.remove_unknown) await removeReactionAsBot(reaction, emojiKey, user.id);
      return;
    }

    const guild = message.guild ?? client.guilds.cache.get(guildId);
    const member = await guild?.members.fetch(user.id).catch(() => null);
    if (!member || member.user.bot) return;
    const role = guild.roles.cache.get(roleId);
    if (!guard.botCanManageRole(guild, role)) {
      // Usually: the role is above the bot's own highest role. Say so (once per
      // role per 10 minutes) instead of failing silently.
      warnUnmanageable(guild, role, roleId, user);
      return;
    }

    if (added) {
      if (!meetsRequired((id) => member.roles.cache.has(id), store.required.get(guildId, "reaction", message.id))) {
        // Not allowed: take the reaction back so the menu doesn't look used.
        await removeReactionAsBot(reaction, emojiKey, user.id);
        logActivity(`${user.tag} was refused @${role.name} (missing a required role)`);
        return;
      }
      if (group?.exclusive) await dropOtherGroupRoles(guild, member, store.state.get(guildId), group, roleId);
      if (!member.roles.cache.has(roleId)) await member.roles.add(role, "Reaction role");
      store.reaction.remember(guildId, member.id, roleId);
      logActivity(`${user.tag} picked @${role.name}`);
    } else {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(role, "Reaction role removed");
        logActivity(`${user.tag} dropped @${role.name}`);
      }
      store.reaction.forget(guildId, member.id, roleId);
    }
  });
}

// ---------------------------------------------------------------- components

/** Throws unless the member holds one of the message's required roles. */
function assertRequired(member, kind, messageId) {
  const need = store.required.get(member.guild.id, kind, messageId);
  if (!meetsRequired((id) => member.roles.cache.has(id), need))
    throw new UserError(`You need one of these roles to use this: ${mentions([...need])}`);
}

/** "role:b:<roleId>": toggle that role. */
async function onButton(interaction, roleId) {
  const { guild, member, message } = interaction;
  if (!store.button.forMessage(guild.id, message.id).some((b) => b.role_id === roleId))
    throw new UserError("This button role no longer exists.");
  assertRequired(member, "button", message.id);
  const role = guild.roles.cache.get(roleId);
  if (!guard.botCanManageRole(guild, role))
    throw new UserError("I can't give that role anymore (it was deleted or is above my highest role). Tell a moderator.");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const had = member.roles.cache.has(roleId);
  if (had) await member.roles.remove(role, "Button role");
  else await member.roles.add(role, "Button role");
  await interaction.editReply({ embeds: [embeds.success(interaction.client, `${had ? "Removed" : "Added"} ${role}`)] });
}

/** "role:d": a member submitted a dropdown role menu. */
async function onSelect(interaction) {
  const { guild, member, message } = interaction;
  const menu = store.dropdown.get(guild.id, message.id);
  if (!menu) throw new UserError("This dropdown no longer gives roles.");
  assertRequired(member, "dropdown", message.id);

  const changes = dropdownChanges({
    menuRoles: menu.options.map((o) => o.role_id),
    held: new Set(member.roles.cache.keys()),
    selected: interaction.values,
    exclusive: menu.exclusive,
    max: menu.max_values,
  });

  // Re-sending the same components clears the member's visible selection, so
  // the menu is ready for the next pick.
  await interaction.update({ components: rowsFor(message) });
  const result = await applyRoles(member, changes, "Dropdown role");

  const lines = [];
  if (result.added.length) lines.push(`Added ${mentions(result.added)}`);
  if (result.removed.length) lines.push(`Removed ${mentions(result.removed)}`);
  if (result.skipped.length) lines.push(`I can't manage ${mentions(result.skipped)}; tell a moderator.`);
  await interaction.followUp({
    embeds: [embeds.info(interaction.client, lines.join("\n") || "Nothing changed.")],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------- setup

module.exports = (client) => {
  void client;

  listeners.on("guildMemberAdd", { name: "autorole:join", module: "autorole" }, async (_client, member) => {
    // Membership screening: wait until they accept the rules (guildMemberUpdate below).
    if (member.pending) return;
    await giveJoinRoles(member);
  });

  listeners.on("guildMemberUpdate", { name: "autorole:screening", module: "autorole" }, async (_client, oldMember, newMember) => {
    if (newMember.pending !== false) return;
    if (oldMember.pending === true) return giveJoinRoles(newMember);
    // After a restart the old state may be unknown (partial). Treat a recent
    // joiner in a screened server as "just passed screening"; giveJoinRoles
    // only adds roles they don't have, so a repeat is harmless.
    if (
      oldMember.partial &&
      newMember.guild.features.includes(GuildFeature.MemberVerificationGateEnabled) &&
      Date.now() - (newMember.joinedTimestamp ?? 0) < DAY
    )
      return giveJoinRoles(newMember);
  });

  listeners.on("messageReactionAdd", { name: "autorole:reaction-add", module: "autorole" }, (c, reaction, user) =>
    onReaction(c, reaction, user, true)
  );
  listeners.on("messageReactionRemove", { name: "autorole:reaction-remove", module: "autorole" }, (c, reaction, user) =>
    onReaction(c, reaction, user, false)
  );

  // Housekeeping (not module-gated: it only keeps our tables accurate).
  listeners.on("messageDelete", { name: "autorole:message-delete" }, (_c, message) => {
    if (message.guildId && store.state.get(message.guildId).messages.has(message.id)) store.forgetMessage(message.guildId, message.id);
  });
  listeners.on("messageDeleteBulk", { name: "autorole:message-delete-bulk" }, (_c, messages, channel) => {
    const owned = store.state.get(channel.guildId).messages;
    for (const id of messages.keys()) if (owned.has(id)) store.forgetMessage(channel.guildId, id);
  });
  listeners.on("roleDelete", { name: "autorole:role-delete" }, async (_c, role) => {
    for (const { messageId, channelId } of store.forgetRole(role.guild.id, role.id)) await redraw(role.guild, channelId, messageId);
  });

  components.register(PREFIX, async (interaction, _client, [kind, roleId]) => {
    if (!interaction.inCachedGuild()) return;
    if (kind === "b" && interaction.isButton()) return onButton(interaction, roleId);
    if (kind === "d" && interaction.isStringSelectMenu()) return onSelect(interaction);
  });
};

module.exports.giveJoinRoles = giveJoinRoles;
module.exports.onReaction = onReaction;
module.exports.activity = activity;
