/**
 * Channel counters: a channel whose name shows a live number ("Members: 1,234").
 *
 * Discord allows only about 2 renames per channel per 10 minutes, so each
 * counter is a repeating scheduler job ("automation:counter") every 10
 * minutes, and it only renames when the name actually changed. Overdue jobs
 * run as soon as the bot boots, so counters catch up after a restart.
 *
 * The rename itself is NOT awaited: if Discord rate-limits it, discord.js
 * would wait (possibly minutes) and block the shared scheduler loop for every
 * package. Instead we fire it off and record the name; on failure the stored
 * name is cleared so the next run tries again.
 */
const { scheduler } = require("../../core");
const store = require("./db");
const fmt = require("./format");

const JOB = "automation:counter";

/** Every member, fetched when the cache is incomplete (needs GuildMembers intent). */
async function allMembers(guild) {
  if (guild.members.cache.size >= guild.memberCount) return guild.members.cache;
  return guild.members.fetch();
}

/** Counts bans page by page (1000 per request, capped at 10 pages). */
async function banCount(guild) {
  let total = 0;
  let after;
  for (let i = 0; i < 10; i++) {
    const page = await guild.bans.fetch({ limit: 1000, after, cache: false });
    total += page.size;
    if (page.size < 1000) break;
    after = page.lastKey();
  }
  return total;
}

/** The raw number for a counter option. */
async function value(guild, option) {
  switch (option) {
    case "members":
      return guild.memberCount;
    case "humans":
      return (await allMembers(guild)).filter((m) => !m.user.bot).size;
    case "bots":
      return (await allMembers(guild)).filter((m) => m.user.bot).size;
    case "online": {
      // Presence data needs the privileged GuildPresences intent, which this
      // bot doesn't use. Discord's approximate count works without it.
      const fresh = await guild.client.guilds.fetch({ guild: guild.id, withCounts: true, force: true });
      return fresh.approximatePresenceCount ?? 0;
    }
    case "boosts":
      return guild.premiumSubscriptionCount ?? 0;
    case "boost_tier":
      return guild.premiumTier ?? 0;
    case "channels":
      return guild.channels.cache.filter((c) => !c.isThread()).size;
    case "roles":
      return guild.roles.cache.size - 1; // without @everyone
    case "voice":
      return guild.voiceStates.cache.filter((s) => s.channelId && !s.member?.user.bot).size;
    case "banned":
      return banCount(guild);
    default:
      throw new Error(`unknown counter option ${option}`);
  }
}

/** The channel name a counter should have right now. */
async function render(guild, counter) {
  const n = await value(guild, counter.option);
  return fmt.counterName(counter.name_template, fmt.formatCount(n, { prettify: counter.prettify, currency: counter.currency }));
}

/**
 * Renames the channel if its rendered name changed since the last rename.
 * Returns "gone" when the channel no longer exists, otherwise the name.
 */
async function update(client, channelId) {
  const counter = store.counters.get(channelId);
  if (!counter) return "gone";
  const guild = client.guilds.cache.get(counter.guild_id);
  if (!guild) return null;
  const channel = await guild.channels.fetch(channelId).catch((err) => (err.code === 10003 ? null : undefined));
  if (channel === null) {
    store.counters.remove(channelId);
    return "gone";
  }
  if (!channel) return null;

  const name = await render(guild, counter);
  if (name === counter.last_name) return name; // unchanged: don't spend a rename
  store.counters.setLastName(channelId, name);
  channel.setName(name, "Channel counter update").catch((err) => {
    console.warn(`[automation] counter #${channelId} rename failed: ${err.message}`);
    store.counters.setLastName(channelId, null); // retry on the next run
  });
  return name;
}

const schedule = (guildId, channelId, when = Date.now() + fmt.COUNTER_INTERVAL_MS) =>
  scheduler.schedule(JOB, when, { channelId }, { guildId, key: channelId });

const unschedule = (channelId) => scheduler.cancel(JOB, channelId);

scheduler.define(JOB, async (job, client) => {
  const result = await update(client, job.payload.channelId);
  if (result === "gone") return undefined;
  return Date.now() + fmt.COUNTER_INTERVAL_MS;
});

module.exports = { value, render, update, schedule, unschedule };
