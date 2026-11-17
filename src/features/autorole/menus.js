/**
 * Discord-side helpers shared by the /autorole command and the listeners:
 * redrawing a message's role buttons / dropdown, and giving or taking roles.
 */
const { MessageFlags } = require("discord.js");
const { guard } = require("../../core");
const store = require("./db");
const { buildRows, isOurRow } = require("./logic");

/** True when the bot can put components on `message` (its own, not Components V2). */
const canEdit = (message) =>
  message.author?.id === message.client.user.id && !message.flags?.has(MessageFlags.IsComponentsV2) && !message.webhookId;

/**
 * Rebuilds the components of `message` from the database: our dropdown and
 * buttons, plus whatever rows were there that aren't ours. Throws a
 * UserError (from buildRows) if it doesn't fit; the caller decides whether
 * to save first.
 */
function rowsFor(message) {
  const guildId = message.guildId;
  return buildRows({
    menu: store.dropdown.get(guildId, message.id),
    buttons: store.button.forMessage(guildId, message.id),
    foreign: message.components.filter((row) => !isOurRow(row)),
  });
}

/** Edits `message` so its components match the database. */
const redrawMessage = (message) => message.edit({ components: rowsFor(message) });

/**
 * Same, for a message we only know by ID (role deleted, reset...). Never
 * throws: returns the edited message, or null if it's gone / not editable.
 */
async function redraw(guild, channelId, messageId) {
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    const message = await channel?.messages?.fetch(messageId).catch(() => null);
    if (!message || !canEdit(message)) return null;
    return await redrawMessage(message);
  } catch (err) {
    console.warn(`[autorole] couldn't redraw ${messageId}: ${err.message}`);
    return null;
  }
}

/**
 * Adds / removes roles on a member, skipping roles the bot can't manage
 * (deleted, above the bot, managed). Returns { added, removed, skipped } as
 * role IDs.
 */
async function applyRoles(member, { add = [], remove = [] }, reason) {
  const ok = (id) => guard.botCanManageRole(member.guild, member.guild.roles.cache.get(id));
  const result = {
    added: add.filter(ok),
    removed: remove.filter(ok),
    skipped: [...add, ...remove].filter((id) => !ok(id)),
  };
  // roles.set() would be one call, but would also have to carry every other
  // role; add/remove only touch the roles we mean to change.
  if (result.added.length) await member.roles.add(result.added, reason);
  if (result.removed.length) await member.roles.remove(result.removed, reason);
  return result;
}

module.exports = { canEdit, rowsFor, redrawMessage, redraw, applyRoles };
