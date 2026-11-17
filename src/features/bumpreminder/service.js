/**
 * What happens on a bump and when the reminder fires.
 *
 * Flow:
 *   DISBOARD says "Bump done"  -> handleBump(): save the bumper, send the
 *     thank-you, schedule "bumpreminder:remind" in 2 h (key = guild id, so a
 *     new bump moves the pending reminder), and lock the channel if autolock.
 *   2 h later -> the scheduler runs remind(): unlock, then post the reminder.
 *
 * The reminder lives in core's scheduled_jobs table, so it survives restarts.
 */
const { PermissionFlagsBits: P } = require("discord.js");
const { scheduler, script, ui } = require("../../core");
const store = require("./db");
const logic = require("./logic");

const KIND = "bumpreminder:remind";

/** The two permissions autolock denies to @everyone. */
const LOCK_FLAGS = { SendMessages: P.SendMessages, UseApplicationCommands: P.UseApplicationCommands };

/** The pending reminder job for a guild, or null. */
const pendingJob = (guildId) => scheduler.list(KIND, guildId).find((j) => j.key === guildId) ?? null;

/**
 * Denies SendMessages / UseApplicationCommands for @everyone. Returns what
 * those permissions were before, so unlock() can restore them.
 */
async function lock(channel) {
  const everyone = channel.guild.roles.everyone;
  const current = channel.permissionOverwrites.cache.get(everyone.id);
  const restore = {};
  for (const [name, flag] of Object.entries(LOCK_FLAGS)) restore[name] = logic.overwriteState(current, flag);
  await channel.permissionOverwrites.edit(everyone, { SendMessages: false, UseApplicationCommands: false }, { reason: "Bump reminder: locked until the next bump" });
  return restore;
}

/** Puts @everyone's two permissions back to what lock() saw. */
async function unlock(channel, restore) {
  const values = {};
  for (const name of Object.keys(LOCK_FLAGS)) values[name] = restore?.[name] ?? null;
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, values, { reason: "Bump reminder: ready to bump" });
}

const fetchChannel = (client, id) => (id ? client.channels.fetch(id).catch(() => null) : null);

/** Called by the listener once detectBump() says DISBOARD confirmed a bump. */
async function handleBump(client, message, { bumperId }) {
  const guildId = message.guildId;
  const settings = store.get(guildId);
  const now = Date.now();
  const nextBumpAt = now + logic.BUMP_COOLDOWN_MS;

  store.update(guildId, { next_bump_at: nextBumpAt, last_bumper_id: bumperId ?? settings.last_bumper_id });

  // 1. Thank-you (unless switched off).
  const thankyou = logic.thankyouScript(settings);
  if (thankyou) {
    const member = bumperId ? await message.guild.members.fetch(bumperId).catch(() => null) : null;
    const user = member?.user ?? (bumperId ? await client.users.fetch(bumperId).catch(() => null) : null);
    try {
      await ui.safeSend(message.channel, script.render(thankyou, {
        member, user, guild: message.guild, channel: message.channel,
        vars: { next_bump: `<t:${Math.floor(nextBumpAt / 1000)}:R>` },
      }));
    } catch (err) {
      console.warn(`[bumpreminder] thank-you in ${guildId} failed to render: ${err.message}`);
    }
  }

  // 2. Lock. If the channel is already locked from an earlier bump (an admin
  //    bumped through the lock), keep the original "before" state.
  const previous = pendingJob(guildId)?.payload ?? {};
  let restore = previous.restore ?? null;
  if (settings.autolock && !restore) {
    try {
      restore = await lock(message.channel);
    } catch (err) {
      console.warn(`[bumpreminder] could not lock #${message.channel.name} in ${guildId}: ${err.message}`);
    }
  }

  // 3. Reminder in 2 hours (moves any pending one).
  scheduler.schedule(KIND, nextBumpAt, { channelId: message.channelId, restore }, { guildId, key: guildId });
}

/** Scheduler handler: unlock, then post the reminder. */
async function remind(job, client) {
  const guildId = job.guild_id;
  const settings = store.get(guildId);
  const { restore, channelId } = job.payload ?? {};

  // Unlock the channel the lock was applied to, even if the feature was
  // switched off or moved since.
  if (restore) {
    const locked = await fetchChannel(client, channelId);
    if (locked) await unlock(locked, restore).catch((err) => console.warn(`[bumpreminder] unlock failed in ${guildId}: ${err.message}`));
  }

  if (!settings.enabled || !settings.channel_id) return;
  const channel = await fetchChannel(client, settings.channel_id);
  if (!channel) return;

  const lastBumper = settings.last_bumper_id ? await client.users.fetch(settings.last_bumper_id).catch(() => null) : null;
  let payload;
  try {
    payload = script.render(logic.reminderScript(settings), {
      user: lastBumper ?? undefined,
      guild: channel.guild,
      channel,
      vars: {
        last_bumper: settings.last_bumper_id ? `<@${settings.last_bumper_id}>` : "nobody yet",
        "last_bumper.id": settings.last_bumper_id ?? "",
      },
      allowedMentions: logic.reminderMentions(settings.pingable),
    });
  } catch (err) {
    console.warn(`[bumpreminder] reminder in ${guildId} failed to render: ${err.message}`);
    return;
  }
  await ui.safeSend(channel, logic.withPing(payload, settings.pingable, settings.last_bumper_id));
}

scheduler.define(KIND, remind);

/**
 * Cancels the pending reminder and lifts the lock right away (used by
 * `off` and `clear channel`). Safe to call when nothing is pending.
 */
async function cancel(client, guildId) {
  const job = pendingJob(guildId);
  scheduler.cancel(KIND, guildId);
  if (job?.payload?.restore) {
    const channel = await fetchChannel(client, job.payload.channelId);
    if (channel) await unlock(channel, job.payload.restore).catch(() => {});
  }
}

module.exports = { KIND, LOCK_FLAGS, handleBump, remind, cancel, pendingJob, lock, unlock };
