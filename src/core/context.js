/**
 * "Which server is this about?" for the code that is running right now.
 *
 * Event handlers run inside run(guildId, fn) (handlers/events.js,
 * core/listeners.js, core/scheduler.js, the web panel's music routes). Node's
 * AsyncLocalStorage carries that guild ID through every await, timer and
 * callback started from there, so deep code can ask currentGuildId() without
 * the ID being passed along.
 *
 * utils/settings.js uses it to make client.colour, client.defaultVolume,
 * client.leaveOnEmpty... return the current server's own value (set in the
 * web panel) or the bot-wide default.
 */
const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

/** Runs fn with `guildId` as the current server (no-op wrapper when guildId is empty). */
const run = (guildId, fn) => (guildId ? storage.run(String(guildId), fn) : fn());

const currentGuildId = () => storage.getStore() ?? null;

/**
 * Finds the guild an event is about from its arguments: anything with a
 * guildId / guild (messages, members, interactions, voice states, channels)
 * or a DisTube Queue (its id is the guild ID).
 */
function guildIdOf(args) {
  for (const a of args) {
    if (!a || typeof a !== "object") continue;
    if (typeof a.guildId === "string") return a.guildId;
    if (a.guild?.id) return a.guild.id;
    if (a.message?.guildId) return a.message.guildId; // reactions
    if ("voiceChannel" in a && "songs" in a && typeof a.id === "string") return a.id; // DisTube Queue
  }
  return null;
}

module.exports = { run, currentGuildId, guildIdOf };
