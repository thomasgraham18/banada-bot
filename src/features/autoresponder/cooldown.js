/**
 * In-memory cooldowns so a busy channel can't make the bot spam replies or
 * reactions (and get rate-limited by Discord).
 *
 *   const cooldowns = new Cooldowns(3000);
 *   if (!cooldowns.take(`${channelId}:${trigger}`)) return;  // still cooling down
 *
 * take() is "check and start": it returns true and starts the cooldown when
 * the key is free, false while it is still running. Nothing is persisted:
 * after a restart every cooldown is simply free again.
 */
class Cooldowns {
  /**
   * @param {number} ms default cooldown length
   * @param {{ max?: number }} [options] expired keys are swept once the map
   *   grows past `max`, so memory stays bounded however many keys are used.
   */
  constructor(ms, { max = 10_000 } = {}) {
    this.ms = ms;
    this.max = max;
    this.until = new Map(); // key -> unix ms when the cooldown ends
  }

  /** True (and starts the cooldown) if `key` is not cooling down. */
  take(key, now = Date.now(), ms = this.ms) {
    const end = this.until.get(key);
    if (end !== undefined && end > now) return false;
    this.until.set(key, now + ms);
    if (this.until.size > this.max) this.sweep(now);
    return true;
  }

  /** Ms left on a key's cooldown (0 = free). */
  remaining(key, now = Date.now()) {
    return Math.max(0, (this.until.get(key) ?? 0) - now);
  }

  /** Drops expired keys. */
  sweep(now = Date.now()) {
    for (const [key, end] of this.until) if (end <= now) this.until.delete(key);
  }

  clear() {
    this.until.clear();
  }

  get size() {
    return this.until.size;
  }
}

module.exports = { Cooldowns };
