/**
 * Web panel: a small HTTP server (no extra dependencies) that serves the
 * management UI from web/public and a JSON API under /api.
 *
 *   WEB_PORT   (config.json or env) port, default 3000
 *   WEB_HOST   (config.json or env) bind address, default 127.0.0.1 (this PC
 *              only). Use 0.0.0.0 in Docker / to reach it from your network.
 *   WEB_TOKEN  (config.json or env) panel password. When unset, one is
 *              generated, saved to data/panel.json and printed at startup.
 *
 * Every /api request needs "Authorization: Bearer <token>".
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomBytes, timingSafeEqual } = require("crypto");
const { ChannelType } = require("discord.js");
const { RepeatMode } = require("distube");
const { blue, magenta, yellow } = require("chalk");
const config = require("../config.json");
const store = require("../utils/store");
const settings = require("../utils/settings");
const schedule = require("../utils/schedule");
const reactionRoles = require("../utils/reactionRoles");
const player = require("../utils/player");
const panel = require("./panel");
const oauth = require("./oauth");
const context = require("../core/context");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_VOLUME = 200;

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- auth

function panelToken() {
  const configured = process.env.WEB_TOKEN || config.WEB_TOKEN;
  if (configured) return String(configured);

  const saved = store.read("panel", {});
  if (saved.token) return saved.token;
  const token = randomBytes(24).toString("base64url");
  store.write("panel", { token });
  return token;
}

function authorised(req, token) {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// ---------------------------------------------------------------- helpers

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://panel");
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, name));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: "Not found" });

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(data);
  });
}

const getGuild = (client, id) => {
  const guild = client.guilds.cache.get(id);
  if (!guild) throw new HttpError(404, "The bot is not in that server.");
  return guild;
};

const songInfo = (song) =>
  song && {
    name: song.name,
    url: song.url,
    duration: song.formattedDuration,
    thumbnail: song.thumbnail,
    user: song.user?.tag ?? null,
  };

function queueInfo(queue) {
  if (!queue) return null;
  return {
    playing: !queue.paused,
    paused: queue.paused,
    volume: queue.volume,
    repeatMode: ["off", "song", "queue"][queue.repeatMode] ?? "off",
    autoplay: queue.autoplay,
    currentTime: queue.formattedCurrentTime,
    voiceChannel: queue.voiceChannel?.name ?? null,
    textChannel: queue.textChannel?.name ?? null,
    current: songInfo(queue.songs[0]),
    upcoming: queue.songs.slice(1, 26).map(songInfo),
    length: queue.songs.length,
    totalDuration: queue.formattedDuration,
  };
}

// ---------------------------------------------------------------- routes

/** [method, regex, handler(ctx)] — ctx = { client, params, body } */
const routes = [
  ["GET", /^\/api\/status$/, ({ client }) => ({
    ready: client.isReady(),
    user: client.user ? { tag: client.user.tag, avatar: client.user.displayAvatarURL() } : null,
    ping: client.ws.ping,
    uptimeMs: Date.now() - client.startedAt,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    guilds: client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL(),
      members: g.memberCount,
      features: {
        gradients: g.features.includes("ENHANCED_ROLE_COLORS"),
        roleIcons: g.features.includes("ROLE_ICONS"),
      },
      queue: queueInfo(client.distube.getQueue(g.id)),
    })),
  })],

  ["GET", /^\/api\/settings$/, ({ client }) => client.settings],
  ["PUT", /^\/api\/settings$/, ({ client, body }) => {
    const saved = settings.update(client, body);
    schedule.restart(client);
    return saved;
  }],
  ["POST", /^\/api\/commands\/post-list$/, async ({ client }) => {
    await schedule.sendCommandList(client);
    return { ok: true };
  }],

  ["GET", /^\/api\/commands$/, ({ client }) =>
    client.commands.map((c) => ({
      name: c.data.name,
      description: c.data.description,
      options: (c.data.options ?? []).map((o) => o.toJSON?.().name ?? o.name),
    }))],

  // ?all=1 also returns voice channels and categories (with a `kind`).
  ["GET", /^\/api\/guilds\/(\d+)\/channels$/, ({ client, params, query }) => {
    const all = query.get("all") === "1";
    const kindOf = (c) =>
      c.type === ChannelType.GuildCategory ? "category" : c.isVoiceBased() ? "voice" : c.isTextBased() ? "text" : null;
    return getGuild(client, params[0])
      .channels.cache.filter((c) =>
        all ? kindOf(c) && !c.isThread() : [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type)
      )
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name, parent: c.parent?.name ?? null, kind: kindOf(c) }));
  }],

  // ---------------------------------------------------------------- per-server feature settings (web/panel.js)
  ["GET", /^\/api\/panel\/schema$/, () => panel.publicSchema()],
  ["GET", /^\/api\/guilds\/(\d+)\/commandpaths$/, ({ client }) => ({
    paths: [...panel.commandPaths(client)].sort(),
    modules: [...client.commands.keys()].sort(),
  })],
  ["GET", /^\/api\/guilds\/(\d+)\/panel\/([\w-]+)$/, ({ client, params }) =>
    panel.readPackage(getGuild(client, params[0]), params[1])],
  ["PUT", /^\/api\/guilds\/(\d+)\/panel\/([\w-]+)\/(\d+)$/, ({ client, params, body }) =>
    panel.saveSection(getGuild(client, params[0]), params[1], params[2], body.values)],
  ["POST", /^\/api\/guilds\/(\d+)\/panel\/([\w-]+)\/(\d+)\/rows$/, ({ client, params, body }) =>
    panel.addRow(getGuild(client, params[0]), params[1], params[2], body.values)],
  ["POST", /^\/api\/guilds\/(\d+)\/panel\/([\w-]+)\/(\d+)\/delete$/, ({ client, params, body }) =>
    panel.deleteRow(getGuild(client, params[0]), params[1], params[2], body.key)],
  ["PUT", /^\/api\/guilds\/(\d+)\/command-levels$/, ({ client, params, body }) =>
    panel.setCommandLevel(getGuild(client, params[0]), body.command, body.level)],
  ["GET", /^\/api\/guilds\/(\d+)\/members$/, ({ client, params, query }) =>
    panel.searchMembers(getGuild(client, params[0]), query.get("q"))],
  // "Connect Discord" (web/oauth.js): command-menu visibility per server.
  ["GET", /^\/api\/guilds\/(\d+)\/oauth$/, ({ params }) => oauth.status(params[0])],
  ["POST", /^\/api\/guilds\/(\d+)\/oauth\/start$/, ({ client, params }) => {
    getGuild(client, params[0]);
    try {
      return { url: oauth.startUrl(params[0]) };
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }],
  ["POST", /^\/api\/guilds\/(\d+)\/oauth\/sync$/, ({ client, params }) => oauth.sync(client, getGuild(client, params[0]).id)],
  ["POST", /^\/api\/guilds\/(\d+)\/oauth\/disconnect$/, ({ params }) => oauth.disconnect(params[0])],
  ["POST", /^\/api\/guilds\/(\d+)\/script-preview$/, ({ client, params, body }) => {
    const guild = getGuild(client, params[0]);
    return panel.previewScript(guild, guild.members.me, body.script);
  }],

  ["GET", /^\/api\/guilds\/(\d+)\/roles$/, async ({ client, params }) => {
    const guild = getGuild(client, params[0]);
    await guild.roles.fetch();
    const me = guild.members.me;
    return guild.roles.cache
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        colour: r.hexColor,
        colour2: r.colors?.secondaryColor
          ? `#${r.colors.secondaryColor.toString(16).padStart(6, "0")}`
          : null,
        icon: r.unicodeEmoji ?? r.iconURL() ?? null,
        managed: r.managed,
        editable: Boolean(me && r.editable),
        members: r.members.size,
      }));
  }],

  ["GET", /^\/api\/guilds\/(\d+)\/emojis$/, async ({ client, params }) => {
    const guild = getGuild(client, params[0]);
    await guild.emojis.fetch().catch(() => {});
    return guild.emojis.cache.map((e) => ({
      id: e.id,
      name: e.name,
      animated: e.animated,
      url: e.imageURL(),
      text: e.toString(),
    }));
  }],

  // One colour/icon board per server: ?guild=<id> (GET) or body.guildId (PUT/POST).
  ["GET", /^\/api\/reaction-roles$/, ({ query }) => {
    try {
      return reactionRoles.getBoard(query.get("guild"));
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }],
  ["PUT", /^\/api\/reaction-roles$/, ({ body }) => reactionRoles.setBoard(body)],
  ["GET", /^\/api\/reaction-roles\/template$/, () => ({ groups: reactionRoles.template() })],
  ["POST", /^\/api\/reaction-roles\/preview$/, ({ body }) => {
    const board = reactionRoles.sanitize(body, reactionRoles.getBoard(body.guildId));
    const messages = [];
    if (board.intro.content.trim())
      messages.push({ label: "Intro", content: board.intro.content.trim() });
    for (const group of board.groups)
      for (const menu of group.menus)
        messages.push({ label: menu.title, content: reactionRoles.renderMenu(group, menu) });
    return messages.map((m) => ({
      ...m,
      length: m.content.length,
      tooLong: m.content.length > reactionRoles.MAX_MESSAGE_LENGTH,
    }));
  }],
  ["POST", /^\/api\/reaction-roles\/(create-roles|restyle|publish|repost)$/, ({ client, params, body }) => {
    const guildId = body.guildId;
    const action = params[0];
    try {
      if (action === "create-roles") reactionRoles.ensureRoles(client, guildId);
      else if (action === "restyle") reactionRoles.ensureRoles(client, guildId, { restyle: true });
      else reactionRoles.publish(client, guildId, { repost: action === "repost" });
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    return reactionRoles.job;
  }],
  ["GET", /^\/api\/reaction-roles\/job$/, () => reactionRoles.job],
  // Reactions are handled by the /autorole engine (the board syncs its menus into it).
  ["GET", /^\/api\/reaction-roles\/activity$/, () =>
    require("../handlers/features").api("autorole")?.activity() ?? []],

  ["POST", /^\/api\/music\/(\d+)\/(\w+)$/, async ({ client, params, body }) => {
    const [guildId, action] = params;
    const queue = client.distube.getQueue(guildId);
    if (!queue) throw new HttpError(409, "Nothing is playing in that server.");

    switch (action) {
      case "pause": if (!queue.paused) await queue.pause(); break;
      case "resume": if (queue.paused) await queue.resume(); break;
      case "toggle": queue.paused ? await queue.resume() : await queue.pause(); break;
      case "skip":
        if (queue.songs.length > 1 || queue.autoplay) await queue.skip();
        else await player.stop(client, queue);
        break;
      case "previous":
        if (!queue.previousSongs.length) throw new HttpError(409, "There is no previous song.");
        await queue.previous();
        break;
      case "stop": await player.stop(client, queue); break;
      case "shuffle": await queue.shuffle(); break;
      case "autoplay": queue.toggleAutoplay(); break;
      case "loop": {
        const modes = { off: RepeatMode.DISABLED, song: RepeatMode.SONG, queue: RepeatMode.QUEUE };
        queue.setRepeatMode(body.mode in modes ? modes[body.mode] : (queue.repeatMode + 1) % 3);
        break;
      }
      case "volume": {
        const volume = Number(body.volume);
        if (!Number.isFinite(volume)) throw new HttpError(400, "volume must be a number.");
        queue.setVolume(Math.min(MAX_VOLUME, Math.max(0, Math.round(volume))));
        break;
      }
      case "remove": {
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 1 || index >= queue.songs.length)
          throw new HttpError(400, "index must point at an upcoming song.");
        queue.songs.splice(index, 1);
        break;
      }
      default:
        throw new HttpError(404, `Unknown action "${action}".`);
    }

    player.refresh(client, guildId);
    return queueInfo(client.distube.getQueue(guildId));
  }],
];

// ---------------------------------------------------------------- server

function start(client) {
  const port = Number(process.env.WEB_PORT || config.WEB_PORT || 3000);
  const host = process.env.WEB_HOST || config.WEB_HOST || "127.0.0.1";
  if (String(process.env.WEB_DISABLED || config.WEB_DISABLED) === "true") return null;
  const token = panelToken();
  oauth.start(client);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://panel");
    // Discord's OAuth redirect lands here (no panel token: the browser comes
    // from discord.com). web/oauth.js only accepts a state it issued itself.
    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      const result = await oauth.handleCallback(client, url.searchParams).catch((err) => ({ ok: false, message: err.message }));
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Banada Panel</title>
        <body style="font:15px system-ui;max-width:520px;margin:15vh auto;padding:0 16px">
        <h2>${result.ok ? "✅ Discord connected" : "❌ Couldn't connect"}</h2><p>${esc(result.message)}</p>
        <p><a href="/">Back to the panel</a> (you can close this tab).</p></body>`);
    }

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
      return serveStatic(req, res);
    }

    if (!authorised(req, token)) return send(res, 401, { error: "Wrong or missing panel token." });

    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) return send(res, 404, { error: "Unknown API route." });

    try {
      const body = ["PUT", "POST"].includes(req.method) ? await readBody(req) : {};
      const params = route[1].exec(url.pathname).slice(1);
      // Routes about one server run in its context, so per-server settings
      // (e.g. the player colour after a panel music action) resolve correctly.
      const guildId = /^\/api\/(?:guilds|music)\/(\d+)/.exec(url.pathname)?.[1] ?? null;
      const result = await context.run(guildId, () => route[2]({ client, params, body, query: url.searchParams }));
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      // UserError = bad input the user can fix (core/errors.js) -> 400 with its message.
      const status = err instanceof HttpError ? err.status : err?.name === "UserError" ? 400 : 500;
      if (status === 500) console.error(`[web] ${req.method} ${url.pathname} failed:`, err);
      send(res, status, { error: err?.message ?? String(err) });
    }
  });

  server.on("error", (err) =>
    console.error(yellow("[WARN]"), `Web panel could not start on ${host}:${port}:`, err.message)
  );
  server.listen(port, host, () => {
    const shown = host === "0.0.0.0" ? "localhost" : host;
    console.log(
      `${blue("[INFO]")} Web panel: ${magenta(`http://${shown}:${port}/#token=${token}`)}`
    );
  });
  return server;
}

module.exports = { start, routes };
