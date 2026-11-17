/**
 * Offline self-check. Does NOT log in to Discord and sends nothing to it.
 *
 *   npm run check                 -> dependencies, commands, events
 *   npm run check -- "lofi beats" -> also tests the audio pipeline for a
 *                                    search / URL: resolve -> stream URL ->
 *                                    ffmpeg decode -> Opus encode
 *
 * Exit code 0 = everything passed.
 */
const { spawn, spawnSync } = require("child_process");
const { generateDependencyReport } = require("@discordjs/voice");
const BotClient = require("../bot.js");

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${err.message}`);
  }
};

// Decodes a few seconds of the stream exactly like DisTube does (raw PCM).
const decodeSample = (ffmpegPath, url, seconds) =>
  new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      ffmpegPath,
      [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", url,
        "-t", String(seconds),
        "-ar", "48000",
        "-ac", "2",
        "-f", "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const chunks = [];
    let stderr = "";
    ffmpeg.stdout.on("data", (c) => chunks.push(c));
    ffmpeg.stderr.on("data", (c) => (stderr += c));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      const pcm = Buffer.concat(chunks);
      if (code !== 0 || pcm.length === 0)
        return reject(
          new Error(
            `ffmpeg exited with code ${code}: ${stderr.trim().split("\n").pop()}`
          )
        );
      resolve(pcm);
    });
  });

(async () => {
  const query = process.argv.slice(2).join(" ").trim();
  const client = new BotClient();
  const ffmpegPath = client.distube.options.ffmpeg.path;

  console.log("\nDependencies");
  const report = generateDependencyReport();
  await check("Opus encoder", () => {
    const m = /@discordjs\/opus: (\S+)|opusscript: (\d\S*)/.exec(report);
    if (!m || /not/.test(m[0])) throw new Error("install @discordjs/opus");
    return m[0];
  });
  await check("DAVE (Discord voice encryption)", () => {
    const m = /@snazzah\/davey: (\S+)/.exec(report);
    if (!m || m[1] === "not") throw new Error("@snazzah/davey not found");
    return m[1];
  });
  await check("FFmpeg", () => {
    const out = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8" });
    if (out.error || out.status !== 0)
      throw new Error(`cannot run ffmpeg at "${ffmpegPath}"`);
    return out.stdout.split("\n")[0].trim();
  });
  await check("Single copy of distube", () => {
    const { Song } = require("distube");
    for (const plugin of client.distube.plugins) {
      // Plugins must extend classes from the same distube module as the bot.
      const base = Object.getPrototypeOf(Object.getPrototypeOf(plugin));
      const ours = require("distube")[base.constructor.name];
      if (ours !== base.constructor)
        throw new Error(
          `${plugin.constructor.name} uses a different copy of distube`
        );
    }
    void Song;
    return client.distube.plugins.map((p) => p.constructor.name).join(", ");
  });

  console.log("\nBot code");
  await check("Slash commands load and serialise", () => {
    require("../handlers/commands")(client);
    const names = new Set();
    for (const command of client.commands.values()) {
      const json = command.data.toJSON();
      if (names.has(json.name)) throw new Error(`duplicate /${json.name}`);
      names.add(json.name);
    }
    if (names.size === 0) throw new Error("no commands found");
    return `${names.size} commands`;
  });
  await check("Event handlers load", () => {
    require("../handlers/events")(client);
    const distubeEvents = client.distube.eventNames().length;
    if (!client.distube.listenerCount("error"))
      throw new Error("no DisTube error listener");
    return `${client.eventNames().length} discord.js + ${distubeEvents} DisTube events`;
  });

  await check("Player panel builds", () => {
    const player = require("../utils/player");
    const song = (n) => ({
      name: `Song ${n}`,
      url: `https://youtu.be/${n}`,
      duration: 180,
      formattedDuration: "03:00",
      thumbnail: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      uploader: { name: "Uploader" },
    });
    const queue = {
      songs: [1, 2, 3, 4, 5].map(song),
      previousSongs: [],
      paused: false,
      autoplay: false,
      repeatMode: 0,
      volume: 100,
      currentTime: 45,
      formattedDuration: "15:00",
    };
    // toJSON() runs discord.js's validation of the Components V2 layout.
    for (const payload of [
      player.buildPlayer(client, queue),
      player.buildEnded(client, queue.songs[0]),
      player.buildQueueList(client, queue),
    ])
      payload.components.forEach((component) => component.toJSON());
    return "player, ended and queue layouts";
  });

  await check("Settings load", () => {
    const settings = require("../utils/settings");
    const s = settings.sanitize({ colour: "#abcdef", defaultVolume: 999, leaveOnEmptyTime: 1e15 });
    if (s.colour !== "ABCDEF" || s.defaultVolume !== 200 || s.leaveOnEmptyTime !== 2 ** 31 - 1)
      throw new Error("sanitize did not clamp values");
    return `colour ${client.colour}, volume ${client.defaultVolume}%`;
  });

  await check("Reaction role menus render", () => {
    const rr = require("../utils/reactionRoles");
    const board = rr.sanitize({ groups: rr.template() });
    let count = 0;
    for (const group of board.groups)
      for (const menu of group.menus) {
        const text = rr.renderMenu(group, menu);
        if (text.length > rr.MAX_MESSAGE_LENGTH)
          throw new Error(`"${menu.title}" is ${text.length} characters`);
        if (menu.options.length > 20) throw new Error(`"${menu.title}" has over 20 options`);
        count++;
      }
    if (rr.parseEmoji("<a:x:123>").id !== "123") throw new Error("custom emoji parsing");
    return `${count} template menus`;
  });

  await check("Feature packages: trees valid, every subcommand handled", () => {
    const { loadFeatures, failures } = require("../handlers/features");
    const features = loadFeatures();
    const problems = failures.map((f) => `package "${f.name}" failed to load: ${f.error?.message ?? f.error}`);
    const owners = new Map();
    let subcommands = 0;
    for (const feature of features)
      for (const command of feature.commands) {
        const name = command.data.name;
        if (owners.has(name)) problems.push(`/${name} defined by both ${owners.get(name)} and ${feature.name}`);
        owners.set(name, feature.name);
        problems.push(...(command.validate?.() ?? []));
        subcommands += Object.keys(command.handlers ?? {}).length;
      }
    if (problems.length) throw new Error(`\n      - ${problems.join("\n      - ")}`);
    return `${features.length} packages, ${owners.size} commands, ${subcommands} subcommands`;
  });

  await check("Every command fits Discord's limits (8000 chars each, 100 total)", () => {
    // Discord counts names, descriptions and choice names/values of a whole command tree.
    const size = (o) =>
      (o.name ?? "").length + (o.description ?? "").length +
      (o.choices ?? []).reduce((n, c) => n + String(c.name).length + String(c.value).length, 0) +
      (o.options ?? []).reduce((n, x) => n + size(x), 0);
    const sizes = [...client.commands.values()].map((c) => [c.data.name, size(c.data.toJSON())]);
    const over = sizes.filter(([, n]) => n > 8000);
    if (over.length) throw new Error(over.map(([name, n]) => `/${name} is ${n} chars`).join(", "));
    if (sizes.length > 100) throw new Error(`${sizes.length} top-level commands (max 100)`);
    const [biggest, n] = sizes.sort((a, b) => b[1] - a[1])[0];
    return `${sizes.length} commands, largest /${biggest} at ${n} chars`;
  });

  await check("Web panel routes load", () => {
    const { routes } = require("../web/server");
    const fs = require("fs");
    const page = require("path").join(__dirname, "..", "web", "public", "index.html");
    if (!fs.existsSync(page)) throw new Error("web/public/index.html missing");
    return `${routes.length} API routes`;
  });

  if (query) {
    console.log(`\nAudio pipeline for "${query}"`);
    let song;
    let pcm;
    await check("Resolve song", async () => {
      song = await client.distube.handler.resolve(query);
      if (song.songs) song = song.songs[0]; // playlist -> first track
      return `${song.name} [${song.formattedDuration}] via ${song.source}`;
    });
    if (song) {
      await check("Get stream URL", async () => {
        await client.distube.handler.attachStreamInfo(song);
        const url = song.stream.playFromSource
          ? song.stream.url
          : song.stream.song?.stream.url;
        if (!url) throw new Error("no stream URL returned");
        song.checkUrl = url;
        return new URL(url).hostname;
      });
    }
    if (song?.checkUrl) {
      await check("FFmpeg decodes 5 seconds", async () => {
        pcm = await decodeSample(ffmpegPath, song.checkUrl, 5);
        return `${(pcm.length / (48000 * 2 * 2)).toFixed(1)}s of PCM`;
      });
    }
    if (pcm) {
      await check("Opus encodes a frame", () => {
        const { OpusEncoder } = require("@discordjs/opus");
        // One 20 ms frame (stereo, 16 bit) from the middle: intros are often silent.
        const frameBytes = 960 * 2 * 2;
        const start = Math.floor(pcm.length / 2 / frameBytes) * frameBytes;
        const frame = pcm.subarray(start, start + frameBytes);
        const packet = new OpusEncoder(48000, 2).encode(frame);
        if (!packet.length) throw new Error("empty Opus packet");
        const silent = pcm.every((b) => b === 0);
        return `${packet.length} byte packet${silent ? " (audio is silent!)" : ""}`;
      });
    }
  } else {
    console.log('\nTip: add a search to test playback, e.g. npm run check -- "lofi beats"');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    failed ? `\n${failed} check(s) FAILED.` : "\nAll checks passed."
  );
  // The YouTube plugin keeps a worker thread alive; exit explicitly.
  process.exit(failed ? 1 : 0);
})();
