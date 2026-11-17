/**
 * Pure levelling maths. No Discord, no database, so it can be unit-tested
 * offline (levels.test.js).
 *
 * Bleed's real formula is unknown, so this uses the classic MEE6-style curve:
 *
 *   XP needed to go from level n to n + 1  =  5n² + 50n + 100
 *
 *   level 0 -> 1 : 100 XP      level 1 -> 2 : 155 XP      level 2 -> 3 : 220 XP
 *   level 10 -> 11 : 1,100 XP  level 50 -> 51 : 15,100 XP
 *
 * Only the TOTAL XP is the real source of truth; a member's level is always
 * levelForXp(totalXp). `setlevel` stores totalXpForLevel(level), so the member
 * starts that level with 0 XP into it.
 *
 * XP gain: 15–25 random XP per message, at most once every 60 s per member,
 * times the server multiplier (`/levels setrate`, 0.25–3.0), rounded, min 1.
 */

const MAX_LEVEL = 1000;
const COOLDOWN_MS = 60_000;
const MIN_GAIN = 15;
const MAX_GAIN = 25;
const MIN_MULTIPLIER = 0.25;
const MAX_MULTIPLIER = 3;

/** XP needed to go from `level` to `level + 1`. */
const xpForLevel = (level) => 5 * level * level + 50 * level + 100;

/**
 * Total XP needed to reach `level` from 0, i.e. the sum of xpForLevel(0..level-1).
 * Closed form of Σ(5n² + 50n + 100) for n = 0..L-1:
 *   5·(L-1)L(2L-1)/6 + 50·L(L-1)/2 + 100·L
 */
function totalXpForLevel(level) {
  const L = Math.max(0, Math.min(MAX_LEVEL, Math.floor(level)));
  return (5 * (L - 1) * L * (2 * L - 1)) / 6 + 25 * L * (L - 1) + 100 * L;
}

/** Highest XP a member can hold (enough for MAX_LEVEL). */
const MAX_XP = totalXpForLevel(MAX_LEVEL);

/** The level a member with `xp` total XP is at (binary search over the curve). */
function levelForXp(xp) {
  if (!(xp > 0)) return 0;
  let lo = 0;
  let hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (totalXpForLevel(mid) <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where a member stands inside their current level.
 * @returns {{ level, xp, current, needed, nextLevel, nextXp }}
 *   current = XP earned into this level, needed = XP this level takes,
 *   nextXp  = total XP at which the next level is reached.
 */
function progress(xp) {
  const total = Math.max(0, Math.floor(xp || 0));
  const level = levelForXp(total);
  const base = totalXpForLevel(level);
  const capped = level >= MAX_LEVEL;
  return {
    level,
    xp: total,
    current: total - base,
    needed: capped ? 0 : xpForLevel(level),
    nextLevel: capped ? level : level + 1,
    nextXp: capped ? base : totalXpForLevel(level + 1),
  };
}

/** Clamps a multiplier to the allowed range. */
const clampMultiplier = (m) => Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, Number(m) || 1));

/**
 * XP for one message: random 15–25, times the multiplier, rounded, at least 1.
 * `random` is injectable so tests are deterministic.
 */
function rollXp(multiplier = 1, random = Math.random) {
  const base = MIN_GAIN + Math.floor(random() * (MAX_GAIN - MIN_GAIN + 1));
  return Math.max(1, Math.round(base * clampMultiplier(multiplier)));
}

/**
 * Which level roles a member should gain / lose at `level`.
 *
 * @param {{ level: number, roleId: string }[]} levelRoles every configured level role
 * @param {number} level the member's level
 * @param {boolean} stack true: keep every earned role; false: only the highest earned one
 * @param {Set<string>} has role IDs the member currently holds
 * @returns {{ keep: string[], add: string[], remove: string[] }}
 *   `remove` also covers roles for levels the member hasn't reached, so the
 *   same function reconciles after setxp / removexp / sync.
 */
function planLevelRoles(levelRoles, level, stack, has = new Set()) {
  const earned = levelRoles.filter((r) => r.level <= level).sort((a, b) => a.level - b.level);
  const keepRoles = stack ? earned : earned.slice(-1);
  const keep = [...new Set(keepRoles.map((r) => r.roleId))];
  const keepSet = new Set(keep);
  const add = keep.filter((id) => !has.has(id));
  const remove = [...new Set(levelRoles.map((r) => r.roleId))].filter((id) => !keepSet.has(id) && has.has(id));
  return { keep, add, remove };
}

/** A text progress bar like ▰▰▰▱▱▱▱▱▱▱. */
function progressBar(current, needed, width = 12) {
  const ratio = needed > 0 ? Math.min(1, Math.max(0, current / needed)) : 1;
  const filled = Math.round(ratio * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** Short explanation shown in `/levels config`. */
const FORMULA_TEXT =
  `Each message earns ${MIN_GAIN}–${MAX_GAIN} XP × the server rate, at most once every ${COOLDOWN_MS / 1000}s. ` +
  "Going from level n to n+1 takes 5n² + 50n + 100 XP (level 1 = 100 XP, level 10 = 4,675 XP total).";

module.exports = {
  MAX_LEVEL,
  MAX_XP,
  COOLDOWN_MS,
  MIN_GAIN,
  MAX_GAIN,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  FORMULA_TEXT,
  xpForLevel,
  totalXpForLevel,
  levelForXp,
  progress,
  clampMultiplier,
  rollXp,
  planLevelRoles,
  progressBar,
};
