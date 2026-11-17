/**
 * Leaderboards: one persistent message per (guild, kind, timeframe), edited
 * by the scheduler every 10 minutes ("automation:leaderboard").
 *
 * messages / voice / invites come from our own activity stats (activity.js);
 * levels comes from the levels package through its api, which may be absent.
 */
const { scheduler, script, ui, UserError } = require("../../core");
const store = require("./db");
const activity = require("./activity");
const fmt = require("./format");

const JOB = "automation:leaderboard";
const jobKey = (guildId, kind, timeframe) => `${guildId}:${kind}:${timeframe}`;

/** The levels package's api, or null. Looked up lazily (packages load in any order). */
const levelsApi = () => require("../../handlers/features").api("levels");

/** Throws if a kind/timeframe combination can't work. */
function assertSupported(kind, timeframe) {
  if (kind === "levels") {
    if (timeframe !== "alltime") throw new UserError("Levels only have an **all time** leaderboard (XP never resets per period).");
    if (!levelsApi()) throw new UserError("The levels package isn't installed, so there is no levels data to rank.");
  }
}

/**
 * Ranked rows for a board: [{ userId, value, level?, xp? }], best first.
 * Returns { rows, note } where note explains an empty board we can't fill.
 */
async function rows(guildId, kind, timeframe) {
  if (kind === "levels") {
    const api = levelsApi();
    if (!api?.getLeaderboard) return { rows: [], note: "The levels package isn't installed." };
    const list = (await api.getLeaderboard(guildId, { limit: fmt.LEADERBOARD_SIZE, offset: 0 })) ?? [];
    return { rows: list.map((r) => ({ userId: r.userId, value: r.xp, xp: r.xp, level: r.level })) };
  }
  activity.flush(); // include the last minute of buffered activity
  return { rows: store.stats.top(guildId, kind, fmt.periodStart(timeframe), fmt.LEADERBOARD_SIZE) };
}

/** The message payload for a board (also used by `view`). */
async function payload(guild, channel, board) {
  const { rows: ranked, note } = await rows(guild.id, board.kind, board.timeframe);
  const emotes = store.boards.emotes(guild.id, board.kind);
  const stored = fmt.boardScript(board.script, board.kind, ranked, emotes);
  const body = script.render(stored, { guild, channel, vars: fmt.boardVars(board.kind, board.timeframe) });
  if (note) body.content = `${body.content && body.content !== "​" ? `${body.content}\n` : ""}-# ${note}`;
  body.allowedMentions = { parse: [] }; // a board mentions up to 10 people: never ping them
  return body;
}

/**
 * Re-renders a board. Edits its message, or posts a new one when the old
 * message is gone (or `resend` is set). Returns false if the board no longer
 * exists or its channel was deleted (the board is then removed).
 */
async function refresh(client, guildId, kind, timeframe, { resend = false } = {}) {
  const board = store.boards.get(guildId, kind, timeframe);
  if (!board) return false;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return true; // bot not in the guild right now; try again later
  const channel = await guild.channels.fetch(board.channel_id).catch((err) => (err.code === 10003 ? null : undefined));
  if (channel === null) {
    store.boards.remove(guildId, kind, timeframe);
    return false;
  }
  if (!channel) return true; // transient fetch error

  const body = await payload(guild, channel, board);
  if (board.message_id && !resend) {
    const edited = await channel.messages
      .edit(board.message_id, { ...body, content: body.content ?? "" })
      .then(() => true)
      .catch((err) => (err.code === 10008 ? false : Promise.reject(err)));
    if (edited) return true;
  }
  if (resend && board.message_id) await channel.messages.delete(board.message_id).catch(() => {});
  const sent = await ui.safeSend(channel, body);
  if (!sent) throw new UserError(`I can't post in ${channel}. I need View Channel, Send Messages and Embed Links there.`);
  store.boards.setMessage(guildId, kind, timeframe, sent.id);
  return true;
}

const schedule = (guildId, kind, timeframe) =>
  scheduler.schedule(JOB, Date.now() + fmt.LEADERBOARD_REFRESH_MS, { guildId, kind, timeframe }, { guildId, key: jobKey(guildId, kind, timeframe) });

const unschedule = (guildId, kind, timeframe) => scheduler.cancel(JOB, jobKey(guildId, kind, timeframe));

scheduler.define(JOB, async (job, client) => {
  const { guildId, kind, timeframe } = job.payload;
  try {
    if (!(await refresh(client, guildId, kind, timeframe))) return undefined; // board gone: stop
  } catch (err) {
    // Missing permissions etc.: keep the job and try again next round.
    if (!(err instanceof UserError) && !err.code) throw err;
  }
  return Date.now() + fmt.LEADERBOARD_REFRESH_MS;
});

// Daily housekeeping: daily buckets older than ~2 months are never read
// (monthly needs at most 31 days), so drop them. All-time rows are kept.
const PRUNE_JOB = "automation:prune-stats";
scheduler.define(PRUNE_JOB, async () => {
  store.stats.prune(fmt.dayStart() - 62 * 86_400_000);
  return Date.now() + 86_400_000;
});
function ensurePruneJob() {
  if (!scheduler.list(PRUNE_JOB).length) scheduler.schedule(PRUNE_JOB, Date.now() + 3_600_000, {}, { key: "global" });
}

module.exports = { assertSupported, rows, payload, refresh, schedule, unschedule, ensurePruneJob, levelsApi };
