/**
 * Per-guild read cache for data that listeners need on every event.
 *
 * Listeners (messageCreate, reactions, joins...) run constantly, so they must
 * not query the database each time. Wrap the loader once:
 *
 *   const triggers = guildCache((guildId) =>
 *     db.all("SELECT * FROM autoresponders WHERE guild_id = ?", guildId));
 *
 *   triggers.get(guildId)         // loads once, then served from memory
 *   triggers.invalidate(guildId)  // call after every write for that guild
 *
 * Loaders must be synchronous (node:sqlite is) and should return data that is
 * cheap to use on the hot path (Maps / Sets / pre-compiled regexes).
 */
const all = new Set();

function guildCache(loader) {
  const store = new Map();
  const cache = {
    get(guildId) {
      if (!store.has(guildId)) store.set(guildId, loader(guildId));
      return store.get(guildId);
    },
    invalidate(guildId) {
      if (guildId === undefined) store.clear();
      else store.delete(guildId);
    },
  };
  all.add(cache);
  return cache;
}

/** Drops every cache for a guild (e.g. after /settings reset). */
guildCache.invalidateGuild = (guildId) => {
  for (const cache of all) cache.invalidate(guildId);
};

module.exports = { guildCache };
