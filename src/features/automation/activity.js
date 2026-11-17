/**
 * Activity tracking for leaderboards: messages sent, seconds in voice and
 * invites used. Only guilds with a board of that kind are tracked
 * (db.trackedKinds, cached), so nothing is stored for servers that never
 * asked for it.
 *
 * Writes are buffered in memory and flushed every minute (and before a board
 * is drawn), so a busy channel costs one Map update per message instead of a
 * database write. A crash loses at most a minute of counts.
 */
const { PermissionFlagsBits } = require("discord.js");
const store = require("./db");
const { dayStart } = require("./format");

const FLUSH_MS = 60_000;

/** "guild|kind|user" -> amount not yet written. */
const pending = new Map();

function bump(guildId, kind, userId, amount = 1) {
  if (amount <= 0) return;
  const key = `${guildId}|${kind}|${userId}`;
  pending.set(key, (pending.get(key) ?? 0) + amount);
}

// ---------------------------------------------------------------- voice

/** "guild|user" -> ms timestamp up to which voice time has been credited. */
const sessions = new Map();

/** Does this voice state earn voice time? (in a channel, not AFK, not a bot) */
const counts = (state) =>
  Boolean(state?.channelId) && state.channelId !== state.guild?.afkChannelId && !state.member?.user?.bot;

/** Credits voice time accrued so far to every open session. */
function creditSessions(now = Date.now()) {
  for (const [key, since] of sessions) {
    const [guildId, userId] = key.split("|");
    bump(guildId, "voice", userId, Math.floor((now - since) / 1000));
    // Keep the sub-second remainder so nothing is lost between flushes.
    sessions.set(key, now - ((now - since) % 1000));
  }
}

function voiceUpdate(oldState, newState) {
  const guildId = newState.guild.id;
  if (!store.trackedKinds.get(guildId).has("voice")) return;
  const key = `${guildId}|${newState.id}`;
  const now = Date.now();
  const since = sessions.get(key);
  if (since != null) {
    bump(guildId, "voice", newState.id, Math.floor((now - since) / 1000));
    sessions.delete(key);
  }
  if (counts(newState)) sessions.set(key, now);
}

/** On boot: whoever is already in voice starts a session now. */
function seedVoice(client) {
  for (const guildId of store.boards.guildsWithKind("voice")) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const state of guild.voiceStates.cache.values())
      if (counts(state)) sessions.set(`${guildId}|${state.id}`, Date.now());
  }
}

/** Starts sessions for a guild that just created its first voice board. */
function seedVoiceGuild(guild) {
  for (const state of guild.voiceStates.cache.values()) {
    const key = `${guild.id}|${state.id}`;
    if (counts(state) && !sessions.has(key)) sessions.set(key, Date.now());
  }
}

// ---------------------------------------------------------------- invites

/**
 * guildId -> Map(code -> { uses, inviterId }). There is no GuildInvites
 * intent in this bot, so we cannot hear inviteCreate; instead we fetch the
 * invite list when someone joins and see which code's use count went up.
 * Codes we have not seen before count as previously having 0 uses.
 */
const inviteUses = new Map();

async function fetchInvites(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
  return new Map(invites.map((i) => [i.code, { uses: i.uses ?? 0, inviterId: i.inviterId ?? null }]));
}

async function seedInvites(guild) {
  const map = await fetchInvites(guild);
  if (map) inviteUses.set(guild.id, map);
}

async function memberJoined(member) {
  const guild = member.guild;
  if (member.user.bot || !store.trackedKinds.get(guild.id).has("invites")) return;
  const before = inviteUses.get(guild.id);
  const after = await fetchInvites(guild);
  if (!after) return;
  inviteUses.set(guild.id, after);
  if (!before) return; // nothing to compare against yet

  // Exactly one code should have gone up; if several did (simultaneous
  // joins), we can't tell who invited whom, so credit nobody.
  const used = [...after].filter(([code, info]) => info.uses > (before.get(code)?.uses ?? 0));
  if (used.length !== 1) return;
  const inviterId = used[0][1].inviterId;
  if (inviterId && inviterId !== member.id) bump(guild.id, "invites", inviterId, 1);
}

// ---------------------------------------------------------------- flushing

/** Writes everything buffered to the database (one transaction). */
function flush() {
  creditSessions();
  if (!pending.size) return;
  const bucket = dayStart();
  const entries = [...pending];
  pending.clear();
  require("../../core").db.transaction(() => {
    for (const [key, amount] of entries) {
      const [guildId, kind, userId] = key.split("|");
      store.stats.add(guildId, userId, kind, amount, bucket);
    }
  });
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      flush();
    } catch (err) {
      console.error("[automation] activity flush failed:", err);
    }
  }, FLUSH_MS);
  timer.unref?.();
}

module.exports = { bump, voiceUpdate, seedVoice, seedVoiceGuild, seedInvites, memberJoined, flush, start, pending, sessions };
