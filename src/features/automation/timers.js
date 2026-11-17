/**
 * Timers (auto messages): post a script in a channel every `interval`.
 *
 * Each timer is a repeating scheduler job ("automation:timer", key = channel
 * ID). Before posting, the previous post is deleted so the channel doesn't
 * fill up with copies.
 *
 * Activity requirement (`/automation timer activity`, per guild): only post
 * if a non-bot member has written in the channel since the last post. We ask
 * Discord for the messages after our last post instead of tracking activity
 * in memory, so it still works right after a restart.
 */
const { scheduler, script, ui } = require("../../core");
const store = require("./db");

const JOB = "automation:timer";

async function hadActivity(channel, lastMessageId) {
  if (!lastMessageId) return true;
  const after = await channel.messages.fetch({ after: lastMessageId, limit: 50 }).catch(() => null);
  if (!after) return true; // can't tell: don't block the timer
  return after.some((m) => !m.author.bot && !m.system);
}

/** Posts the timer once. Returns false if the timer or its channel is gone. */
async function run(client, channelId) {
  const timer = store.timers.get(channelId);
  if (!timer) return false;
  const guild = client.guilds.cache.get(timer.guild_id);
  if (!guild) return true;
  const channel = await guild.channels.fetch(channelId).catch((err) => (err.code === 10003 ? null : undefined));
  if (channel === null) {
    store.timers.remove(channelId);
    return false;
  }
  if (!channel?.isTextBased()) return true;

  if (store.timers.activity(guild.id) && !(await hadActivity(channel, timer.last_message_id))) return true;

  if (timer.last_message_id) await channel.messages.delete(timer.last_message_id).catch(() => {});
  const sent = await ui.safeSend(channel, script.render(timer.script, { guild, channel }));
  store.timers.posted(channelId, sent?.id ?? null);
  return true;
}

const schedule = (guildId, channelId, intervalMs) =>
  scheduler.schedule(JOB, Date.now() + intervalMs, { channelId }, { guildId, key: channelId });

const unschedule = (channelId) => scheduler.cancel(JOB, channelId);

/** When a timer will next post, or null. */
const nextRun = (guildId, channelId) => scheduler.list(JOB, guildId).find((j) => j.key === channelId)?.run_at ?? null;

scheduler.define(JOB, async (job, client) => {
  if (!(await run(client, job.payload.channelId))) return undefined;
  // Read the interval again: `timer add` may have changed it.
  const timer = store.timers.get(job.payload.channelId);
  return timer ? Date.now() + timer.interval_ms : undefined;
});

module.exports = { run, schedule, unschedule, nextRun };
