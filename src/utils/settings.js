/**
 * Bot settings that can be changed while the bot is running (web panel).
 *
 * config.json supplies the starting values; anything changed in the panel is
 * saved to data/settings.json and wins from then on. Secrets (token, Spotify
 * keys) stay in config.json and are never exposed here.
 */
const config = require("../config.json");
const store = require("./store");

const FILE = "settings";

// setTimeout cannot wait longer than this (about 24.8 days).
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const defaults = () => ({
  colour: config.EMBED_COLOUR || "580476",
  leaveOnEmpty: config.LEAVE_EMPTY === "true",
  leaveOnEmptyTime: Number(config.LEAVE_EMPTY_TIME) || 0,
  leaveOnFinish: config.LEAVE_FINISH === "true",
  leaveOnStop: config.LEAVE_STOP === "true",
  defaultVolume: 100,
  // Channel that receives the command list on startup and once a day.
  commandsChannelId: config.COMMANDS_CHANNEL_ID || "726031585362706472",
  commandListEnabled: true,
  activities: [
    "thomasg.ca",
    "thomasg.ca/knowledge",
    "/autoplay",
    "/help",
    "/play [song]",
    "Spotify, Soundcloud, YouTube",
  ],
  presenceIntervalSec: 90,
});

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** Coerces anything (a saved file, a panel request) into valid settings. */
function sanitize(input) {
  const base = defaults();
  const raw = { ...base, ...(input && typeof input === "object" ? input : {}) };

  const colour = String(raw.colour).replace(/^#/, "");
  const activities = (Array.isArray(raw.activities) ? raw.activities : [])
    .map((a) => String(a).trim().slice(0, 128))
    .filter(Boolean)
    .slice(0, 25);

  return {
    colour: /^[0-9a-f]{6}$/i.test(colour) ? colour.toUpperCase() : base.colour,
    leaveOnEmpty: Boolean(raw.leaveOnEmpty),
    leaveOnEmptyTime: clamp(raw.leaveOnEmptyTime, 0, MAX_TIMEOUT_MS, 0),
    leaveOnFinish: Boolean(raw.leaveOnFinish),
    leaveOnStop: Boolean(raw.leaveOnStop),
    defaultVolume: clamp(raw.defaultVolume, 0, 200, 100),
    commandsChannelId: /^\d{5,25}$/.test(String(raw.commandsChannelId))
      ? String(raw.commandsChannelId)
      : "",
    commandListEnabled: Boolean(raw.commandListEnabled),
    activities: activities.length ? activities : base.activities,
    presenceIntervalSec: clamp(raw.presenceIntervalSec, 15, 86400, 90),
  };
}

/** Copies the settings onto the client, where commands and events read them. */
/*
 * Per-server overrides. Each server can set these in the web panel
 * (Server → Bot settings); they are guild_config keys. Everything else in
 * this file is the bot-wide default.
 *
 * client.colour, client.defaultVolume, client.leaveOn*... are getters: inside
 * an event for a server (core/context.js) they return that server's override,
 * otherwise the bot-wide value. So code that reads client.colour needs no
 * change to become per-server.
 */
const GUILD_OVERRIDES = {
  colour: ["bot_colour", (v) => (typeof v === "number" ? v.toString(16).padStart(6, "0") : String(v).replace(/^#/, "")).toUpperCase()],
  defaultVolume: ["music_default_volume", Number],
  leaveOnEmpty: ["music_leave_empty", Boolean],
  leaveOnEmptyTime: ["music_leave_empty_ms", (v) => Math.min(MAX_TIMEOUT_MS, Math.max(0, Number(v) || 0))],
  leaveOnFinish: ["music_leave_finish", Boolean],
  leaveOnStop: ["music_leave_stop", Boolean],
  commandsChannelId: ["command_list_channel", String],
  commandListEnabled: ["command_list_enabled", Boolean],
};

/** The effective settings for one server (bot-wide defaults + that server's overrides). */
function forGuild(client, guildId) {
  const { config } = require("../core");
  const out = { ...client.settings };
  if (!guildId) return out;
  for (const [prop, [key, convert]] of Object.entries(GUILD_OVERRIDES)) {
    const value = config.get(guildId, key);
    if (value !== undefined && value !== null && value !== "") out[prop] = convert(value);
  }
  return out;
}

function apply(client, settings) {
  client.settings = settings;
  if (client.__settingsGetters) return;
  client.__settingsGetters = true;
  const { currentGuildId } = require("../core/context");
  for (const prop of Object.keys(GUILD_OVERRIDES))
    Object.defineProperty(client, prop, {
      configurable: true,
      enumerable: true,
      get() {
        const guildId = currentGuildId();
        return guildId ? forGuild(client, guildId)[prop] : client.settings[prop];
      },
      set() {
        throw new Error(`client.${prop} is read-only; change it with utils/settings.update() or the web panel`);
      },
    });
}

function load(client) {
  apply(client, sanitize(store.read(FILE, {})));
}

/** Merges a change from the panel, saves it and applies it immediately. */
function update(client, patch) {
  const settings = sanitize({ ...client.settings, ...patch });
  store.write(FILE, settings);
  apply(client, settings);
  return settings;
}

module.exports = { load, update, sanitize, forGuild, GUILD_OVERRIDES };
