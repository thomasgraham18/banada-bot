/**
 * Loads feature packages from src/features/<name>/index.js.
 *
 * A package's index.js exports:
 *   {
 *     name: "levels",
 *     commands: [defineCommand(...), ...],   // one per top-level command it owns
 *     setup(client) { ... },                 // optional: listeners.on(), components.register()
 *     api: { ... },                          // optional: functions other packages may call
 *   }
 * Its migrations and scheduler.define() calls run when the file is required.
 *
 * Other packages reach an api through features.api("levels"), which returns
 * null when that package isn't installed, so packages stay independent.
 */
const { readdirSync, existsSync } = require("fs");
const path = require("path");
const { green, magenta, red } = require("chalk");

const FEATURES_DIR = path.join(__dirname, "..", "features");

let loaded = null;
/** Packages that threw while loading: [{ name, error }]. Reported by npm run check. */
const failures = [];

/** Requires every package once (safe to call from deployCommands too). */
function loadFeatures() {
  if (loaded) return loaded;
  loaded = [];
  if (!existsSync(FEATURES_DIR)) return loaded;
  for (const dir of readdirSync(FEATURES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const entry = path.join(FEATURES_DIR, dir.name, "index.js");
    if (!existsSync(entry)) continue;
    try {
      const feature = require(entry);
      loaded.push({ name: feature.name ?? dir.name, commands: feature.commands ?? [], setup: feature.setup, api: feature.api ?? null });
    } catch (err) {
      // One broken package must not take the bot down.
      failures.push({ name: dir.name, error: err });
      console.error(red(`[ERROR] Feature "${dir.name}" failed to load:`), err);
    }
  }
  return loaded;
}

/**
 * Requires every .js file in <packageDir>/commands (for packages whose
 * commands are one module per file, like music). Sorted for a stable order.
 */
function loadCommandFiles(packageDir) {
  const dir = path.join(packageDir, "commands");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => require(path.join(dir, file)));
}

/** Every command module defined by a feature package. */
const featureCommands = () => loadFeatures().flatMap((f) => f.commands);

/** Another package's api, or null if it isn't installed. */
const api = (name) => loadFeatures().find((f) => f.name === name)?.api ?? null;

/** Called once from bot.connect(), before login. */
function init(client) {
  const { listeners, scheduler } = require("../core");
  for (const feature of loadFeatures()) {
    try {
      feature.setup?.(client);
    } catch (err) {
      console.error(red(`[ERROR] Feature "${feature.name}" setup failed:`), err);
    }
  }
  listeners.attach(client);
  client.once("clientReady", () => scheduler.start(client));
  console.log(`${green("[SUCCESS]")} Loaded ${magenta(loaded.length)} feature packages.`);
}

module.exports = { loadFeatures, loadCommandFiles, featureCommands, api, init, failures };
