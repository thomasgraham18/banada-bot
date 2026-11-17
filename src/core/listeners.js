/**
 * Shared event bus for feature listeners.
 *
 * events/<dir>/<eventName>.js only allows one file per event, but many
 * packages need messageCreate, guildMemberAdd, etc. Packages register here
 * instead (in their setup(client)):
 *
 *   listeners.on("messageCreate", { name: "levels:xp", module: "levels", event: "levels_xp" },
 *     async (client, message) => { ... });
 *
 * With `module` / `event` set, the call is skipped when /access disables that
 * module or event in the channel, or the channel/author is /ignore'd.
 * Errors are caught and logged with the listener's name.
 */
const access = require("./access");
const context = require("./context");

/** eventName -> [{ name, module, event, scope, priority, always, handler }], sorted by priority */
const registry = new Map();

/*
 * Ordering and "consumed" messages.
 *
 * Listeners run one after another, lowest `priority` first (default 100).
 * Moderation listeners (honeypot 5, filter 10) run before everything else and
 * call consume(message) when they deleted/punished it; later listeners then
 * skip that message (no autoresponder reply, XP, sticky repost...), unless
 * they registered with `always: true` (e.g. cleanup that must see deletes).
 */
const DEFAULT_PRIORITY = 100;
const consumed = new Map(); // messageId -> expiry
function consume(message) {
  if (!message?.id) return;
  consumed.set(message.id, Date.now() + 60_000);
  if (consumed.size > 5000) for (const [id, until] of consumed) if (until < Date.now()) consumed.delete(id);
}
const isConsumed = (message) => {
  const until = message?.id && consumed.get(message.id);
  return Boolean(until && until > Date.now());
};
/** The message an event is about, for message events. */
const messageOf = (eventName, args) =>
  eventName === "messageCreate" ? args[0] : eventName === "messageUpdate" ? args[1] : null;
const attached = new Set();
let clientRef = null;

/**
 * Works out guild / channel / user for the access check from the event's
 * arguments. Covers messages, reactions, members and voice states.
 */
function defaultScope(eventName, args) {
  let first = args[0];
  if (eventName === "messageUpdate" || eventName === "guildMemberUpdate") first = args[1];
  const message = first?.message ?? first; // reaction -> its message
  return {
    guildId: message?.guildId ?? message?.guild?.id ?? null,
    channel: message?.channel ?? null,
    userId: message?.author?.id ?? (eventName.startsWith("messageReaction") ? args[1]?.id : first?.id) ?? null,
  };
}

function dispatch(eventName) {
  return async (...args) => {
    const message = messageOf(eventName, args);
    for (const entry of registry.get(eventName) ?? []) {
      if (message && !entry.always && isConsumed(message)) continue;
      try {
        if (entry.module || entry.event) {
          const scope = entry.scope ? entry.scope(...args) : defaultScope(eventName, args);
          if (!access.listenerAllowed({ ...scope, module: entry.module, event: entry.event })) continue;
        }
        await context.run(context.guildIdOf(args), () => entry.handler(clientRef, ...args));
      } catch (err) {
        console.error(`[listener ${entry.name}] ${eventName} failed:`, err);
      }
    }
  };
}

/**
 * @param {string} eventName a discord.js client event
 * @param {{ name: string, module?: string, event?: string, scope?: Function }} options
 * @param {(client, ...args) => any} handler
 */
function on(eventName, options, handler) {
  if (!registry.has(eventName)) registry.set(eventName, []);
  const list = registry.get(eventName);
  list.push({ ...options, priority: options.priority ?? DEFAULT_PRIORITY, handler });
  list.sort((a, b) => a.priority - b.priority); // stable: equal priorities keep registration order
  if (clientRef && !attached.has(eventName)) {
    clientRef.on(eventName, dispatch(eventName));
    attached.add(eventName);
  }
}

/** Called once by handlers/features.js before login. */
function attach(client) {
  clientRef = client;
  for (const eventName of registry.keys()) {
    if (attached.has(eventName)) continue;
    client.on(eventName, dispatch(eventName));
    attached.add(eventName);
  }
}

module.exports = { on, attach, consume, isConsumed, registry };
