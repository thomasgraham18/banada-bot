const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection } = require("discord.js");
const { DisTube } = require("distube");
const { YouTubePlugin } = require("@distube/youtube");
const { SpotifyPlugin } = require("@distube/spotify");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const { yellow, blue } = require("chalk");
const config = require("./config.json");
const settings = require("./utils/settings");

/**
 * Loads YouTube cookies from cookie.json (EditThisCookie-style JSON export:
 * an array of { name, value, expirationDate, ... }).
 * Returns undefined when the file is missing, invalid or expired, so the bot
 * falls back to anonymous playback instead of sending stale cookies.
 */
function loadYouTubeCookies() {
  const file = path.join(__dirname, "cookie.json");
  if (!fs.existsSync(file)) return undefined;

  let cookies;
  try {
    cookies = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.warn(yellow("[WARN]"), "cookie.json is not valid JSON, ignoring it.");
    return undefined;
  }
  if (!Array.isArray(cookies) || cookies.length === 0) return undefined;

  const now = Date.now() / 1000;
  const expired = cookies.filter(
    (c) => c.expirationDate && c.expirationDate < now
  ).length;
  if (expired > 0) {
    console.warn(
      yellow("[WARN]"),
      `cookie.json: ${expired}/${cookies.length} cookies have expired. ` +
        "Ignoring the file; re-export it if YouTube asks the bot to sign in."
    );
    return undefined;
  }

  return cookies;
}

/**
 * Uses the system ffmpeg when FFMPEG_PATH is set (e.g. in Docker), otherwise
 * the binary bundled by the ffmpeg-static package.
 */
function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static") || "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

class BotClient extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        // Needed by DisTube, VoiceMaster and the voice-channel checks in commands.
        GatewayIntentBits.GuildVoiceStates,
        // Reaction roles, starboard, reaction triggers.
        GatewayIntentBits.GuildMessageReactions,
        // Filters, autoresponders, levels, sticky messages, bump reminders...
        GatewayIntentBits.GuildMessages,
        // PRIVILEGED: must be enabled in the Developer Portal (Bot → Privileged
        // Gateway Intents), or Discord refuses the login.
        GatewayIntentBits.MessageContent, // reading message text (filters, autoresponders)
        GatewayIntentBits.GuildMembers, // joins/leaves, welcome, autoroles, autonick, boosts
        // Bans for the punishment service; emoji/sticker updates.
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildExpressions,
      ],
      // Events for things sent/created before the bot started arrive as partials.
      partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
        Partials.User,
        Partials.GuildMember,
      ],
      allowedMentions: { parse: ["users", "roles"], repliedUser: true },
    });

    // Last-resort error logging so one bad promise doesn't kill the bot.
    process.on("unhandledRejection", (error) => {
      console.error("Unhandled promise rejection:", error);
    });
    process.on("uncaughtException", (error) => {
      console.error("Uncaught exception:", error);
    });

    // Secrets stay in config.json; everything the web panel can change
    // (colour, leave options, volume, presence...) comes from utils/settings.
    this.token = config.DISCORD_TOKEN;
    this.owner = config.OWNER_ID;
    settings.load(this);
    this.startedAt = Date.now();

    // Kept on the client so the /play autocomplete can call youtube.search().
    this.youtube = new YouTubePlugin({ cookies: loadYouTubeCookies() });

    const useSpotifyApi =
      config.SPOTIFY_TOGGLE === "true" &&
      config.SPOTIFY_ID &&
      config.SPOTIFY_SECRET;

    // DisTube v5 has no built-in extractors and no leaveOn* options.
    // Text searches are answered by the first *extractor* plugin (YouTube).
    // Spotify only supplies metadata; its tracks are played through YouTube.
    this.distube = new DisTube(this, {
      plugins: [
        new SpotifyPlugin(
          useSpotifyApi
            ? {
                api: {
                  clientId: config.SPOTIFY_ID,
                  clientSecret: config.SPOTIFY_SECRET,
                },
              }
            : {}
        ),
        this.youtube,
        new SoundCloudPlugin(),
      ],
      ffmpeg: { path: resolveFfmpegPath() },
    });

    // Set DEBUG_DISTUBE=1 to see DisTube / ffmpeg internals in the console.
    if (process.env.DEBUG_DISTUBE) {
      this.distube.on("debug", (m) => console.log(blue("[distube]"), m));
      this.distube.on("ffmpegDebug", (m) => console.log(blue("[ffmpeg]"), m));
    }

    this.commands = new Collection();
  }

  // Shes Alive! (Maybe?)
  async connect() {
    // Load everything *before* logging in so no event fires half-initialised.
    require("./handlers/commands")(this);
    require("./handlers/events")(this);
    // Server-management packages (src/features): listeners, buttons, scheduler.
    require("./handlers/features").init(this);
    require("./web/server").start(this);
    return this.login(this.token);
  }
}

module.exports = BotClient;
