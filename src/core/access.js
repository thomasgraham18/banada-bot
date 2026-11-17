/**
 * Access-control middleware: /ignore and /access command|module|event.
 *
 * Commands: the router calls commandBlock() before every handler.
 * Listeners: core/listeners.js calls listenerAllowed() for listeners that
 * declare a `module` and/or `event`.
 *
 * Check order (guide §4.5): ignored member/channel -> disabled command ->
 * disabled module. Administrators bypass /ignore (but not disabled commands,
 * so admins can still see what members see by testing).
 *
 * WP1 writes the tables through the functions at the bottom, which keep the
 * caches in sync. Never write these tables directly.
 */
const db = require("./db");
const { guildCache } = require("./cache");
const guard = require("./guard");

/** Bot events that /access event can toggle (guide §4.5). */
const EVENTS = [
  "autoresponder", "reaction_trigger", "previous_react", "auto_reaction", "levels_xp",
  "starboard", "clownboard", "sticky_message", "imgonly", "reposter", "publisher",
  "welcome", "goodbye", "boost_message", "bumpreminder", "filter",
];

const ignoreCache = guildCache((guildId) => {
  const rows = db.all("SELECT target_id FROM ignores WHERE guild_id = ?", guildId);
  return new Set(rows.map((r) => r.target_id));
});

// Each set holds "name|channelId|memberId" keys ('' = any).
const commandCache = guildCache((guildId) => {
  const rows = db.all("SELECT command, channel_id, member_id FROM disabled_commands WHERE guild_id = ?", guildId);
  return new Set(rows.map((r) => `${r.command}|${r.channel_id}|${r.member_id}`));
});
const moduleCache = guildCache((guildId) => {
  const rows = db.all("SELECT module, channel_id FROM disabled_modules WHERE guild_id = ?", guildId);
  return new Set(rows.map((r) => `${r.module}|${r.channel_id}`));
});
const eventCache = guildCache((guildId) => {
  const rows = db.all("SELECT event, channel_id FROM disabled_events WHERE guild_id = ?", guildId);
  return new Set(rows.map((r) => `${r.event}|${r.channel_id}`));
});

// A thread inherits its parent channel's settings.
const channelIds = (channel) => [channel?.id, channel?.parentId && channel.isThread?.() ? channel.parentId : null].filter(Boolean);

function isIgnored(guildId, memberId, channel) {
  const set = ignoreCache.get(guildId);
  if (!set.size) return false;
  return set.has(memberId) || channelIds(channel).some((id) => set.has(id));
}

function commandDisabled(guildId, path, channel, memberId) {
  const set = commandCache.get(guildId);
  if (!set.size) return false;
  // "levels rank" is blocked by a row for "levels rank" or for the whole "levels".
  const names = [path, path.split(" ")[0]];
  const channels = ["", ...channelIds(channel)];
  for (const name of names) {
    for (const c of channels) {
      if (set.has(`${name}|${c}|`)) return true; // channel-wide (or everywhere when c = '')
      if (memberId && set.has(`${name}|${c}|${memberId}`)) return true; // this member (here / everywhere)
    }
  }
  return false;
}

function moduleDisabled(guildId, module, channel) {
  const set = moduleCache.get(guildId);
  return set.size > 0 && ["", ...channelIds(channel)].some((c) => set.has(`${module}|${c}`));
}

function eventDisabled(guildId, event, channel) {
  const set = eventCache.get(guildId);
  return set.size > 0 && ["", ...channelIds(channel)].some((c) => set.has(`${event}|${c}`));
}

/**
 * Returns a reason string when the command must not run, otherwise null.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string} path "levels rank"
 * @param {string} module usually the top-level command name
 */
function commandBlock(interaction, path, module) {
  const { guildId, member, channel } = interaction;
  if (!guildId || !member) return null;
  if (!guard.isAdmin(member) && isIgnored(guildId, member.id, channel))
    return "You or this channel are ignored by the bot.";
  if (commandDisabled(guildId, path, channel, member.id))
    return `\`/${path}\` is disabled here.`;
  if (module && moduleDisabled(guildId, module, channel))
    return `The **${module}** module is disabled in this channel.`;
  return null;
}

/** For listeners: false when the module or event is disabled, or the channel/author ignored. */
function listenerAllowed({ guildId, channel, userId, module, event }) {
  if (!guildId) return true;
  if (channel && isIgnored(guildId, userId ?? "", channel)) return false;
  if (module && moduleDisabled(guildId, module, channel)) return false;
  if (event && eventDisabled(guildId, event, channel)) return false;
  return true;
}

// ---------------------------------------------------------------- writes (WP1)

const access = {
  EVENTS,
  isIgnored,
  commandDisabled,
  moduleDisabled,
  eventDisabled,
  commandBlock,
  listenerAllowed,

  setIgnored(guildId, targetId, type, ignored) {
    if (ignored) db.run("INSERT OR REPLACE INTO ignores (guild_id, target_id, type) VALUES (?, ?, ?)", guildId, targetId, type);
    else db.run("DELETE FROM ignores WHERE guild_id = ? AND target_id = ?", guildId, targetId);
    ignoreCache.invalidate(guildId);
  },
  listIgnored: (guildId) => db.all("SELECT target_id, type FROM ignores WHERE guild_id = ?", guildId),

  /** disabled=true adds the row, false removes it. channelId/memberId '' = unscoped. */
  setCommand(guildId, command, disabled, { channelId = "", memberId = "" } = {}) {
    if (disabled)
      db.run("INSERT OR IGNORE INTO disabled_commands (guild_id, command, channel_id, member_id) VALUES (?, ?, ?, ?)", guildId, command, channelId, memberId);
    else
      db.run("DELETE FROM disabled_commands WHERE guild_id = ? AND command = ? AND channel_id = ? AND member_id = ?", guildId, command, channelId, memberId);
    commandCache.invalidate(guildId);
  },
  listCommands: (guildId) => db.all("SELECT command, channel_id, member_id FROM disabled_commands WHERE guild_id = ? ORDER BY command", guildId),

  setModule(guildId, module, disabled, channelId = "") {
    if (disabled) db.run("INSERT OR IGNORE INTO disabled_modules (guild_id, module, channel_id) VALUES (?, ?, ?)", guildId, module, channelId);
    else db.run("DELETE FROM disabled_modules WHERE guild_id = ? AND module = ? AND channel_id = ?", guildId, module, channelId);
    moduleCache.invalidate(guildId);
  },
  listModules: (guildId) => db.all("SELECT module, channel_id FROM disabled_modules WHERE guild_id = ? ORDER BY module", guildId),

  setEvent(guildId, event, disabled, channelId = "") {
    if (disabled) db.run("INSERT OR IGNORE INTO disabled_events (guild_id, event, channel_id) VALUES (?, ?, ?)", guildId, event, channelId);
    else db.run("DELETE FROM disabled_events WHERE guild_id = ? AND event = ? AND channel_id = ?", guildId, event, channelId);
    eventCache.invalidate(guildId);
  },
  listEvents: (guildId) => db.all("SELECT event, channel_id FROM disabled_events WHERE guild_id = ? ORDER BY event", guildId),

  /** /access copy: duplicates every channel-scoped row from one channel to another. */
  copyChannel(guildId, fromId, toId) {
    db.transaction(() => {
      db.run(`INSERT OR IGNORE INTO disabled_commands (guild_id, command, channel_id, member_id)
              SELECT guild_id, command, ?, member_id FROM disabled_commands WHERE guild_id = ? AND channel_id = ?`, toId, guildId, fromId);
      db.run(`INSERT OR IGNORE INTO disabled_modules (guild_id, module, channel_id)
              SELECT guild_id, module, ? FROM disabled_modules WHERE guild_id = ? AND channel_id = ?`, toId, guildId, fromId);
      db.run(`INSERT OR IGNORE INTO disabled_events (guild_id, event, channel_id)
              SELECT guild_id, event, ? FROM disabled_events WHERE guild_id = ? AND channel_id = ?`, toId, guildId, fromId);
    });
    commandCache.invalidate(guildId);
    moduleCache.invalidate(guildId);
    eventCache.invalidate(guildId);
  },

  /** For WP1's /settings staff + /access fakepermissions, which write their own rows. */
  invalidate(guildId) {
    for (const c of [ignoreCache, commandCache, moduleCache, eventCache]) c.invalidate(guildId);
    guard.invalidateFake(guildId);
    guard.invalidateStaff(guildId);
    guard.levels.invalidate(guildId); // staff roles also count as moderators
  },
};

module.exports = access;
