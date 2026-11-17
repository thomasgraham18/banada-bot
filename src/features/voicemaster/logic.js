/**
 * Pure helpers for VoiceMaster (no Discord calls, so they can be unit-tested).
 */
const { script } = require("../../core");

/** Discord voice regions offered by /voicemaster default region. "auto" = let Discord pick. */
const REGIONS = [
  "auto", "brazil", "hongkong", "india", "japan", "rotterdam", "singapore", "south-korea",
  "southafrica", "sydney", "us-central", "us-east", "us-south", "us-west",
];

const DEFAULT_NAME = "{user.display_name}'s channel";

/**
 * /voicemaster clear <setting>: setting -> config columns reset to their default.
 * default_interface is NOT NULL, so it resets to 0 rather than null.
 */
const CLEAR_SETTINGS = {
  name: { default_name: null },
  region: { default_region: null },
  bitrate: { default_bitrate: null },
  interface: { default_interface: 0 },
  join_role: { join_role_id: null },
  default_role: { default_role_id: null },
  public_category: { public_category_id: null },
  private_category: { private_category_id: null },
};

/** Join-to-create cooldown per member, so hopping in and out can't spam channels. */
const CREATE_COOLDOWN_MS = 10_000;
/** Discord allows 2 name changes per voice channel per 10 minutes. */
const RENAME_LIMIT = { max: 2, windowMs: 10 * 60_000 };

/**
 * Sliding-window rate limiter: at most `max` hits per `windowMs` per key.
 *   const limiter = new RateLimiter(2, 600_000);
 *   const wait = limiter.take("channelId");   // 0 = allowed (and counted), else ms to wait
 * `now` is injectable for tests.
 */
class RateLimiter {
  constructor(max, windowMs, now = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map(); // key -> [timestamps]
  }

  /** Recent hits for a key, dropping expired ones. */
  recent(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** ms until `key` may act again (0 = now). Does not count a hit. */
  wait(key) {
    const list = this.recent(key);
    return list.length < this.max ? 0 : list[0] + this.windowMs - this.now();
  }

  /** Counts a hit if allowed. Returns 0 when allowed, otherwise ms to wait. */
  take(key) {
    const wait = this.wait(key);
    if (wait) return wait;
    this.hits.set(key, [...this.recent(key), this.now()]);
    return 0;
  }

  /** Forget a key (e.g. a request that failed and never reached Discord). */
  undo(key) {
    const list = this.recent(key);
    list.pop();
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
  }
}

/**
 * Renders the channel name template for a member. Uses the shared script
 * variables, except that mentions make no sense in a channel name, so
 * {user} / {user.mention} become the display name.
 */
function renderName(template, member) {
  const vars = script.variables({ member, guild: member.guild });
  vars.user = vars["user.mention"] = vars["user.display_name"] ?? member.user?.username ?? "";
  const name = script.substitute(template || DEFAULT_NAME, vars).replace(/\s+/g, " ").trim().slice(0, 100);
  return name || "Voice channel";
}

/** Clamps a kbps value to what the guild's boost tier allows. Returns bits per second. */
function bitrateFor(kbps, guildMaxBitrate = 96_000) {
  const bps = Math.round(kbps) * 1000;
  return Math.max(8000, Math.min(bps, guildMaxBitrate));
}

/** True when nobody but bots is left in a voice channel. */
const isEmptyOfHumans = (channel) => !channel?.members?.some?.((m) => !m.user?.bot);

/** Next user limit after a panel +/- press (0 = unlimited, max 99). */
function stepLimit(current, delta) {
  const next = (current ?? 0) + delta;
  return Math.max(0, Math.min(99, next));
}

const yesNo = (v) => (v ? "Yes" : "No");

module.exports = {
  REGIONS,
  DEFAULT_NAME,
  CLEAR_SETTINGS,
  CREATE_COOLDOWN_MS,
  RENAME_LIMIT,
  RateLimiter,
  renderName,
  bitrateFor,
  isEmptyOfHumans,
  stepLimit,
  yesNo,
};
