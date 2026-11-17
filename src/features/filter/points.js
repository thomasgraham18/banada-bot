/**
 * Points escalation, pure part (tested offline).
 *
 * A filter whose punishment is "points" deletes the message and adds that
 * filter's point value (default 1) to the member. The ladder maps totals to
 * punishments, e.g.
 *
 *   3  timeout 10m
 *   6  jail
 *   10 ban
 *
 * Rules (our design; Bleed's exact behaviour is unknown):
 * - A step fires when the new total reaches it (before < step <= after). If a
 *   single violation jumps over several steps, only the highest one fires.
 * - `/filter points limit` caps the total. A member already at the cap who
 *   offends again gets the highest step at or below the cap re-applied, so the
 *   cap never makes someone immune.
 * - Decay: one point is removed per full 24 h since the member's last
 *   violation (computed lazily when points are read; no timer needed).
 */
const { duration: parseDuration, formatDuration } = require("../../core/parse");
const { UserError } = require("../../core/errors");
const { LADDER_PUNISHMENTS, TYPES, POINT_DECAY_MS, LIMITS, TIMED } = require("./constants");

/** Points left after decay. */
function decayed(points, updatedAt, now = Date.now(), decayMs = POINT_DECAY_MS) {
  if (!points) return 0;
  const steps = Math.floor(Math.max(0, now - updatedAt) / decayMs);
  return Math.max(0, points - steps);
}

/** New total after adding, respecting the limit (null = no limit). */
const addPoints = (current, add, limit) => (limit ? Math.min(current + add, limit) : current + add);

/**
 * The ladder step to apply after a member went from `before` to `after`
 * points, or null. `ladder` must be sorted by points ascending.
 */
function ladderStep(ladder, before, after, limit = null) {
  let step = null;
  for (const s of ladder) if (s.points > before && s.points <= after) step = s;
  if (step) return step;
  if (limit && before >= limit && after >= limit) {
    for (const s of ladder) if (s.points <= after) step = s;
  }
  return step;
}

/**
 * Parses the ladder textarea of /filter points setup. One step per line:
 * "3 timeout 10m", "6: jail 1d", "10 = ban". Returns sorted steps.
 */
function parseLadder(text) {
  const steps = new Map();
  const lines = String(text ?? "").split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > LIMITS.ladder) throw new UserError(`The ladder can have at most ${LIMITS.ladder} steps.`);
  for (const line of lines) {
    const m = /^(\d{1,4})\s*(?:[:=]|pts?|points?)?\s*[:=]?\s*([a-z]+)\s*(.*)$/i.exec(line);
    if (!m) throw new UserError(`Couldn't read ladder line \`${line}\`. Use \`<points> <punishment> [duration]\`, e.g. \`3 timeout 10m\`.`);
    const points = Number(m[1]);
    const punishment = m[2].toLowerCase();
    if (points < 1) throw new UserError(`Ladder points must be at least 1 (\`${line}\`).`);
    if (!LADDER_PUNISHMENTS.includes(punishment))
      throw new UserError(`\`${punishment}\` isn't a ladder punishment. Use one of: ${LADDER_PUNISHMENTS.join(", ")}.`);
    const rest = m[3].trim();
    let durationMs = null;
    if (rest) {
      if (!TIMED.has(punishment)) throw new UserError(`\`${punishment}\` doesn't take a duration (\`${line}\`).`);
      durationMs = parseDuration(rest, { min: 60e3, max: punishment === "timeout" ? 28 * 86400e3 : undefined });
    }
    steps.set(points, { points, punishment, durationMs });
  }
  return [...steps.values()].sort((a, b) => a.points - b.points);
}

/** Ladder steps -> the text parseLadder reads (pre-fills the modal). */
const formatLadder = (ladder) =>
  ladder.map((s) => `${s.points} ${s.punishment}${s.durationMs ? ` ${formatDuration(s.durationMs, 6).replace(/\s+/g, "")}` : ""}`).join("\n");

/**
 * Parses point values per filter: "words=3, spam=2 links 1". Unlisted
 * filters keep 1 point. Returns Map(type -> points).
 */
function parsePointValues(text) {
  const values = new Map();
  const parts = String(text ?? "").split(/[,\n;]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const m = /^([a-z]+)\s*[:= ]\s*(\d{1,3})$/i.exec(part);
    if (!m) throw new UserError(`Couldn't read \`${part}\`. Use \`<filter>=<points>\`, e.g. \`spam=2\`.`);
    const type = m[1].toLowerCase();
    if (!TYPES.includes(type) || type === "names") throw new UserError(`\`${type}\` isn't a message filter.`);
    const points = Number(m[2]);
    if (points < 1 || points > 100) throw new UserError(`Points for ${type} must be 1-100.`);
    values.set(type, points);
  }
  return values;
}

const formatPointValues = (map) => [...map].map(([t, p]) => `${t}=${p}`).join(", ");

module.exports = { decayed, addPoints, ladderStep, parseLadder, formatLadder, parsePointValues, formatPointValues };
