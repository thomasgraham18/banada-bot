/**
 * Listeners for /autoresponder and /reaction.
 *
 * messageCreate is the hottest path in the bot, so every listener here:
 *   - bails out on bots/webhooks/empty messages first,
 *   - reads only the in-memory guildCache (db.js), never the database,
 *   - asks one precompiled matcher (matcher.js) whether anything matches,
 *   - and only then touches Discord, behind an in-memory cooldown.
 *
 * Each feature is a separate listener with its own /access event name, so
 * servers can switch them off per channel:
 *   autoresponder:reply      event "autoresponder"     module "autoresponder"
 *   autoresponder:reactions  event "reaction_trigger"  module "reaction"
 *   autoresponder:previous   event "previous_react"    module "reaction"
 *   autoresponder:channel    event "auto_reaction"     module "reaction"
 *   autoresponder:noselfreact                          module "reaction"
 */
const { PermissionFlagsBits: P } = require("discord.js");
const core = require("../../core");
const store = require("./db");
const matcher = require("./matcher");
const { Cooldowns } = require("./cooldown");

const { listeners, guard, parse, scheduler, script, ui } = core;

/** Cooldown lengths in ms. Keys include the channel, so channels don't block each other. */
const COOLDOWNS = {
  reply: 4000, // same autoresponder in the same channel
  reaction: 2000, // same reaction trigger in the same channel
  previous: 2000, // same previous-react trigger in the same channel
  channel: 1500, // auto reactions for the same member in the same channel
  selfReactPunish: 30_000, // one no-self-react punishment per member per 30 s
};
const cooldowns = Object.fromEntries(Object.entries(COOLDOWNS).map(([k, ms]) => [k, new Cooldowns(ms)]));

const SELF_REACT_TIMEOUT_MS = 5 * 60e3;

// ---------------------------------------------------------------- helpers

/** A thread counts as being in its parent channel too. */
const channelIds = (channel) => [channel?.id, channel?.isThread?.() ? channel.parentId : null].filter(Boolean);

/**
 * /autoresponder exclusive: with channel rows, the message must be in one of
 * them; with role rows, the member must have one of them. Both kinds set =
 * both conditions apply.
 */
function exclusiveAllows(entry, channel, member) {
  if (entry.exclusiveChannels?.size && !channelIds(channel).some((id) => entry.exclusiveChannels.has(id))) return false;
  if (entry.exclusiveRoles?.size) {
    if (!member) return false;
    let ok = false;
    for (const id of entry.exclusiveRoles) if (member.roles.cache.has(id)) ok = true;
    if (!ok) return false;
  }
  return true;
}

/** Plain messages the reply/reaction features should consider at all. */
const relevant = (message) => message.inGuild() && !message.author.bot && !message.webhookId && Boolean(message.content);

const botPerms = (channel) => channel.permissionsFor?.(channel.guild.members.me) ?? null;

const canReact = (channel) => {
  const perms = botPerms(channel);
  return !perms || perms.has([P.ViewChannel, P.AddReactions, P.ReadMessageHistory]);
};

/** Reacts in order; stops early if the message disappears. */
async function reactAll(message, identifiers) {
  for (const identifier of identifiers.slice(0, store.LIMITS.reactionsPerMessage)) {
    try {
      await message.react(identifier);
    } catch (err) {
      if (err.code === 10008 || err.code === 50013 || err.code === 90001) return; // message gone / no permission / blocked
      // Unknown emoji (deleted custom emoji) and the like: try the next one.
    }
  }
}

async function memberOf(message) {
  return message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
}

/** Gives / takes the roles linked to an autoresponder. Skips roles the bot can't manage. */
async function applyRoles(member, entry) {
  const guild = member.guild;
  const usable = (id) => guard.botCanManageRole(guild, guild.roles.cache.get(id));
  const add = entry.addRoles.filter((id) => !member.roles.cache.has(id) && usable(id));
  const remove = entry.removeRoles.filter((id) => member.roles.cache.has(id) && usable(id));
  const reason = `Autoresponder "${entry.trigger}"`.slice(0, 500);
  if (add.length) await member.roles.add(add, reason).catch((err) => console.warn(`[autoresponder] role add: ${err.message}`));
  if (remove.length) await member.roles.remove(remove, reason).catch((err) => console.warn(`[autoresponder] role remove: ${err.message}`));
}

/** Sends the autoresponder's script, as a reply or a plain message. */
async function sendResponse(message, member, entry) {
  const { channel, guild } = message;
  const payload = script.render(entry.script, {
    member,
    user: message.author,
    guild,
    channel,
    vars: { trigger: entry.trigger },
  });

  let sent = null;
  if (entry.reply) {
    const perms = botPerms(channel);
    const allowed = !perms || (perms.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]) && (!payload.embeds.length || perms.has(P.EmbedLinks)));
    if (allowed) sent = await message.reply({ ...payload, failIfNotExists: false }).catch(() => null);
  } else {
    sent = await ui.safeSend(channel, payload);
  }
  if (sent && entry.self_destruct > 0) scheduler.deleteMessageLater(sent, entry.self_destruct * 1000);
}

// ---------------------------------------------------------------- listeners

/** /autoresponder: replies (at most one per message), role actions, delete. */
async function onAutoresponder(client, message) {
  if (!relevant(message)) return;
  const { matcher: compiled, count } = store.caches.autoresponders.get(message.guildId);
  if (!count) return;
  const matches = compiled.match(message.content);
  if (!matches.length) return;

  const command = matcher.looksLikeCommand(message.content);
  let member;
  for (const entry of matches) {
    if (command && !entry.ignore_command_check) continue;
    if (entry.exclusiveRoles.size || entry.addRoles.length || entry.removeRoles.length) member ??= await memberOf(message);
    if (!exclusiveAllows(entry, message.channel, member)) continue;

    // Role actions are per member and idempotent, so they ignore the cooldown.
    if (member && (entry.addRoles.length || entry.removeRoles.length)) await applyRoles(member, entry);

    // The reply is rate limited per channel + trigger.
    if (cooldowns.reply.take(`${message.guildId}:${message.channelId}:${entry.trigger}`)) {
      await sendResponse(message, member ?? message.member, entry);
    }
    if (entry.delete_message) await message.delete().catch(() => {});
    return; // one autoresponder per message: the most specific match wins
  }
}

/** /reaction add: react to the message itself. */
async function onReactionTrigger(client, message) {
  if (!relevant(message)) return;
  const { normal } = store.caches.reactions.get(message.guildId);
  if (!normal.size) return;
  const matches = normal.match(message.content);
  if (!matches.length || !canReact(message.channel)) return;

  const emojis = new Set();
  for (const entry of matches) {
    if (!cooldowns.reaction.take(`${message.guildId}:${message.channelId}:${entry.trigger}`)) continue;
    for (const e of entry.emojis) emojis.add(e);
  }
  if (emojis.size) await reactAll(message, [...emojis]);
}

/**
 * /reaction previousreact add: react to the message being replied to, or
 * else the message just above the trigger.
 */
async function onPreviousReact(client, message) {
  if (!relevant(message)) return;
  const { previous } = store.caches.reactions.get(message.guildId);
  if (!previous.size) return;
  const matches = previous.match(message.content);
  if (!matches.length || !canReact(message.channel)) return;

  const emojis = new Set();
  for (const entry of matches) {
    if (!cooldowns.previous.take(`${message.guildId}:${message.channelId}:${entry.trigger}`)) continue;
    for (const e of entry.emojis) emojis.add(e);
  }
  if (!emojis.size) return;

  let target = null;
  if (message.reference?.messageId) target = await message.fetchReference().catch(() => null);
  if (!target) {
    const before = await message.channel.messages.fetch({ before: message.id, limit: 1 }).catch(() => null);
    target = before?.first() ?? null;
  }
  if (target) await reactAll(target, [...emojis]);
}

/** /reaction messages set: react to every member message in a channel. */
async function onChannelReactions(client, message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;
  const emojis = store.caches.channelReactions.get(message.guildId).get(message.channelId);
  if (!emojis?.length || !canReact(message.channel)) return;
  if (!cooldowns.channel.take(`${message.channelId}:${message.author.id}`)) return;
  await reactAll(message, emojis);
}

/**
 * Pure part of the no-self-react check, separated for tests.
 * Returns true when this reaction should be removed (and punished).
 */
function isPunishableSelfReact(cfg, { reactorId, authorId, emojiKey, channelIds: ids, roleIds, isStaff }) {
  if (!cfg.enabled || !reactorId || reactorId !== authorId) return false;
  if (cfg.emojis.size && !cfg.emojis.has(emojiKey)) return false;
  if (cfg.exempt.size) {
    if (cfg.exempt.has(reactorId)) return false;
    if (ids.some((id) => cfg.exempt.has(id))) return false;
    if (roleIds.some((id) => cfg.exempt.has(id))) return false;
  }
  if (cfg.bypassStaff && isStaff) return false;
  return true;
}

/** /reaction noselfreact: remove (and punish) reactions on your own message. */
async function onSelfReact(client, reaction, user) {
  const guildId = reaction.message.guildId;
  if (!guildId) return;
  const cfg = store.caches.noSelfReact.get(guildId);
  if (!cfg.enabled || user.bot) return; // cheap exit before fetching partials

  if (reaction.partial) reaction = await reaction.fetch();
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (message.author?.id !== user.id) return;

  const guild = message.guild;
  if (user.id === guild.ownerId) return; // the owner can't be punished anyway
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const punishable = isPunishableSelfReact(cfg, {
    reactorId: user.id,
    authorId: message.author.id,
    emojiKey: parse.emojiKey(reaction.emoji),
    channelIds: channelIds(message.channel),
    roleIds: [...member.roles.cache.keys()],
    isStaff: cfg.bypassStaff && guard.isStaff(member),
  });
  if (!punishable) return;

  await reaction.users.remove(user.id).catch(() => {});
  if (cfg.punishment === "none") return;
  if (!cooldowns.selfReactPunish.take(`${guildId}:${user.id}`)) return; // one case per burst

  const result = await core.punish(member, cfg.punishment, {
    reason: "Reacted to their own message (no-self-react)",
    channel: message.channel,
    duration: cfg.punishment === "timeout" ? SELF_REACT_TIMEOUT_MS : undefined,
  });
  if (!result.ok) console.warn(`[autoresponder] no-self-react ${cfg.punishment} failed in ${guild.name}: ${result.error}`);
}

// ---------------------------------------------------------------- registration

function register() {
  listeners.on("messageCreate", { name: "autoresponder:reply", module: "autoresponder", event: "autoresponder" }, onAutoresponder);
  listeners.on("messageCreate", { name: "autoresponder:reactions", module: "reaction", event: "reaction_trigger" }, onReactionTrigger);
  listeners.on("messageCreate", { name: "autoresponder:previous", module: "reaction", event: "previous_react" }, onPreviousReact);
  listeners.on("messageCreate", { name: "autoresponder:channel", module: "reaction", event: "auto_reaction" }, onChannelReactions);
  listeners.on("messageReactionAdd", { name: "autoresponder:noselfreact", module: "reaction" }, onSelfReact);

  // Forget deleted channels / roles (no access checks: this is housekeeping).
  listeners.on("channelDelete", { name: "autoresponder:channelDelete" }, async (client, channel) => {
    if (channel.guildId) store.forgetChannel(channel.guildId, channel.id);
  });
  listeners.on("roleDelete", { name: "autoresponder:roleDelete" }, async (client, role) => {
    store.forgetRole(role.guild.id, role.id);
  });
}

module.exports = register;
module.exports.exclusiveAllows = exclusiveAllows;
module.exports.isPunishableSelfReact = isPunishableSelfReact;
module.exports.COOLDOWNS = COOLDOWNS;
module.exports.cooldowns = cooldowns;
