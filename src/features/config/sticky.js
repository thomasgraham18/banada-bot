/**
 * Sticky messages: keep a message at the bottom of a channel by deleting and
 * reposting it after people talk.
 *
 * Reposting on every message would spam the API (and rate-limit the bot) in a
 * busy channel, so messages only *trigger* a debounced repost: it runs
 * STICKY_WAIT ms after the last message, or at most STICKY_MAX_WAIT ms after
 * the first one of a burst.
 */
const { script, ui } = require("../../core");
const store = require("./db");
const { createDebouncer } = require("./lib");

const STICKY_WAIT = 4000;
const STICKY_MAX_WAIT = 15000;

const debouncer = createDebouncer({ wait: STICKY_WAIT, maxWait: STICKY_MAX_WAIT });

/** Deletes the previous sticky (if any) and posts it again. Returns the new message or null. */
async function repost(channel, { force = false } = {}) {
  const row = store.sticky.get(channel.guildId, channel.id);
  if (!row) return null;
  // Already the newest message? Nothing to do (avoids churn after the bot's own posts).
  if (!force && row.last_message_id && channel.lastMessageId === row.last_message_id) return null;
  if (row.last_message_id) await channel.messages.delete(row.last_message_id).catch(() => {});
  const payload = script.render(row.script, { guild: channel.guild, channel, allowedMentions: { parse: [] } });
  const message = await ui.safeSend(channel, payload);
  // Only remember it if the sticky is still configured (it may have been removed meanwhile).
  if (message && store.sticky.get(channel.guildId, channel.id)) store.sticky.setLastMessage(channel.guildId, channel.id, message.id);
  return message;
}

/** Called for every message in a sticky channel. */
const schedule = (channel) => debouncer.trigger(channel.id, () => repost(channel));
const cancel = (channelId) => debouncer.cancel(channelId);

module.exports = { repost, schedule, cancel, STICKY_WAIT, STICKY_MAX_WAIT };
