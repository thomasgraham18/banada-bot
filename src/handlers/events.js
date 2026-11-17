const { readdirSync } = require("fs");
const path = require("path");
const { green, magenta } = require("chalk");

const EVENTS_DIR = path.join(__dirname, "..", "events");

// discord.js events that must only ever run once.
const ONCE_EVENTS = new Set(["clientReady"]);

/**
 * Wraps a handler so both sync throws and async rejections are logged with
 * the name of the event file instead of escaping as unhandled rejections.
 */
// Runs each handler "inside" the server the event is about (core/context.js),
// so per-server settings (client.colour, client.leaveOnEmpty...) resolve.
const context = require("../core/context");

const safe =
  (label, handler, client) =>
  async (...args) => {
    try {
      await context.run(context.guildIdOf(args), () => handler(client, ...args));
    } catch (err) {
      console.error(`Event error in ${label}:`, err);
    }
  };

const eventFiles = (dir) =>
  readdirSync(path.join(EVENTS_DIR, dir)).filter((file) =>
    file.endsWith(".js")
  );

/**
 * @description Loads all events. The file name is the event name.
 *   events/client + events/guild -> discord.js client events
 *   events/distube               -> DisTube events (attached to client.distube)
 * @param {BotClient} client
 */
module.exports = (client) => {
  let count = 0;

  for (const dir of ["client", "guild"]) {
    for (const file of eventFiles(dir)) {
      const eventName = path.parse(file).name;
      const handler = require(path.join(EVENTS_DIR, dir, file));
      const method = ONCE_EVENTS.has(eventName) ? "once" : "on";
      client[method](eventName, safe(`${dir}/${file}`, handler, client));
      count++;
    }
  }

  for (const file of eventFiles("distube")) {
    const eventName = path.parse(file).name;
    const handler = require(path.join(EVENTS_DIR, "distube", file));
    client.distube.on(eventName, safe(`distube/${file}`, handler, client));
    count++;
  }

  console.log(`${green("[SUCCESS]")} Loaded ${magenta(count)} events.`);
};
