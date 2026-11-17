/**
 * Persistent scheduler: jobs live in the scheduled_jobs table, so giveaways,
 * timers, bump reminders, unmutes, self-destructs... survive restarts.
 *
 * 1. Register a handler for a kind, once, when your package loads:
 *
 *      scheduler.define("giveaway:end", async (job, client) => {
 *        await endGiveaway(client, job.payload.giveawayId);
 *        // return a Date / unix ms to run again (repeating jobs), or nothing to finish
 *      });
 *
 * 2. Schedule it:
 *
 *      scheduler.schedule("giveaway:end", endsAt, { giveawayId }, { guildId, key: String(giveawayId) })
 *
 *    `key` makes the job unique per kind: scheduling the same key again moves
 *    the existing job instead of adding a second one.
 *
 * 3. Cancel:  scheduler.cancel("giveaway:end", key)
 *
 * The loop polls every few seconds. A handler that throws is retried with
 * back-off up to MAX_ATTEMPTS times, then dropped (and logged).
 */
const db = require("./db");
const context = require("./context");

const POLL_MS = 5000;
const MAX_ATTEMPTS = 5;
const BATCH = 50;

const handlers = new Map();
let timer = null;
let running = false;

const toMs = (when) => (when instanceof Date ? when.getTime() : Number(when));

function define(kind, handler) {
  if (handlers.has(kind)) throw new Error(`scheduler kind "${kind}" defined twice`);
  handlers.set(kind, handler);
}

/** Adds (or, with a key, moves) a job. Returns its id. */
function schedule(kind, when, payload = {}, { guildId = null, key = null } = {}) {
  const runAt = toMs(when);
  if (!Number.isFinite(runAt)) throw new Error(`scheduler: bad time for ${kind}`);
  if (key != null) {
    const existing = db.get("SELECT id FROM scheduled_jobs WHERE kind = ? AND key = ?", kind, String(key));
    if (existing) {
      db.run("UPDATE scheduled_jobs SET run_at = ?, payload = ?, guild_id = ?, attempts = 0 WHERE id = ?", runAt, JSON.stringify(payload), guildId, existing.id);
      return existing.id;
    }
  }
  return Number(
    db.run(
      "INSERT INTO scheduled_jobs (kind, guild_id, key, run_at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      kind, guildId, key == null ? null : String(key), runAt, JSON.stringify(payload), Date.now()
    ).lastInsertRowid
  );
}

/** Cancels by key (or every job of the kind for a guild with { guildId }). */
function cancel(kind, key, { guildId } = {}) {
  if (key != null) return db.run("DELETE FROM scheduled_jobs WHERE kind = ? AND key = ?", kind, String(key)).changes;
  if (guildId) return db.run("DELETE FROM scheduled_jobs WHERE kind = ? AND guild_id = ?", kind, guildId).changes;
  return 0;
}

const cancelById = (id) => db.run("DELETE FROM scheduled_jobs WHERE id = ?", id).changes;

/** Pending jobs (for list / view commands). */
const list = (kind, guildId) =>
  db.all("SELECT * FROM scheduled_jobs WHERE kind = ? AND (? IS NULL OR guild_id = ?) ORDER BY run_at", kind, guildId ?? null, guildId ?? null)
    .map((j) => ({ ...j, payload: JSON.parse(j.payload) }));

async function tick(client) {
  if (running) return;
  running = true;
  try {
    const due = db.all("SELECT * FROM scheduled_jobs WHERE run_at <= ? ORDER BY run_at LIMIT ?", Date.now(), BATCH);
    for (const row of due) {
      const job = { ...row, payload: JSON.parse(row.payload) };
      const handler = handlers.get(job.kind);
      if (!handler) continue; // its package isn't loaded; leave it for later
      try {
        const next = await context.run(job.guild_id, () => handler(job, client));
        if (next != null && Number.isFinite(toMs(next)))
          db.run("UPDATE scheduled_jobs SET run_at = ?, attempts = 0, payload = ? WHERE id = ?", toMs(next), JSON.stringify(job.payload), job.id);
        else cancelById(job.id);
      } catch (err) {
        const attempts = job.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          console.error(`[scheduler] ${job.kind} #${job.id} failed ${attempts} times, dropping it:`, err);
          cancelById(job.id);
        } else {
          console.warn(`[scheduler] ${job.kind} #${job.id} failed (attempt ${attempts}), retrying:`, err.message);
          db.run("UPDATE scheduled_jobs SET attempts = ?, run_at = ? WHERE id = ?", attempts, Date.now() + 30_000 * 2 ** attempts, job.id);
        }
      }
    }
  } finally {
    running = false;
  }
}

/** Called once the client is ready (handlers/features.js). */
function start(client) {
  if (timer) return;
  tick(client);
  timer = setInterval(() => tick(client), POLL_MS);
  timer.unref?.();
}

// ---------------------------------------------------------------- built-in kinds

// Self-destructing messages (script.send({ selfDestruct }), ephemeral notices...).
define("core:delete-message", async (job, client) => {
  const channel = await client.channels.fetch(job.payload.channelId).catch(() => null);
  await channel?.messages?.delete(job.payload.messageId).catch(() => {});
});

function deleteMessageLater(message, ms) {
  // Short delays don't need to survive a restart.
  if (ms <= 60_000) {
    setTimeout(() => message.delete().catch(() => {}), ms).unref?.();
    return null;
  }
  return schedule("core:delete-message", Date.now() + ms, { channelId: message.channelId, messageId: message.id }, { guildId: message.guildId });
}

module.exports = { define, schedule, cancel, cancelById, list, start, deleteMessageLater, tick };
