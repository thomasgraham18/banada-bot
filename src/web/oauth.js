/**
 * "Connect Discord": keeps each server's slash-command menu in step with the
 * panel's Permissions page.
 *
 * Why OAuth: staff commands are hidden from members without Manage Messages /
 * Manage Server (default_member_permissions). Moderators added in the panel
 * often lack those, so Discord would hide commands they're allowed to run.
 * Only a server admin, through OAuth (scope applications.commands.permissions.update),
 * may set per-server command visibility; the bot's own token can't. So a
 * server admin connects once, and the bot then writes these overwrites:
 *
 *   command hidden by default, required level = mod   -> allow panel mod + admin roles/users, staff roles
 *   ... required level = admin                         -> allow panel admin roles/users
 *   ... lowered to "member" in Command levels          -> allow @everyone
 *   ... owner only                                     -> nothing (the owner always sees everything)
 *
 * Setup (config.json or environment):
 *   CLIENT_SECRET  the app's OAuth2 client secret (Developer Portal → OAuth2)
 *   PANEL_URL      the panel's address as the browser sees it (default http://localhost:<WEB_PORT>)
 * and add  <PANEL_URL>/oauth/callback  under OAuth2 → Redirects.
 *
 * Tokens are stored encrypted (AES-256-GCM, key from the client secret).
 */
const crypto = require("crypto");
const { ApplicationCommandPermissionType } = require("discord.js");
const { db, guard, scheduler } = require("../core");

let appConfig = {};
try {
  appConfig = require("../config.json");
} catch {
  /* tests */
}

const API = "https://discord.com/api/v10";
const SCOPES = "identify applications.commands.permissions.update";
const MAX_OVERWRITES = 100; // Discord's limit per command per server
const SYNC_KIND = "web:command-permissions";

db.migrate(
  "web_001_oauth",
  `
  -- Discord users who connected (one token per user, shared by their servers).
  CREATE TABLE oauth_users (
    user_id       TEXT PRIMARY KEY,
    username      TEXT,
    access_token  TEXT NOT NULL,   -- encrypted
    refresh_token TEXT NOT NULL,   -- encrypted
    expires_at    INTEGER NOT NULL
  );
  -- Servers whose command menu is kept in sync, and by whose token.
  CREATE TABLE oauth_guilds (
    guild_id     TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    applied_json TEXT NOT NULL DEFAULT '{}',  -- commandId -> hash of the last overwrites sent
    last_sync_at INTEGER,
    last_error   TEXT
  );
`
);

const settings = () => ({
  clientId: appConfig.CLIENT_ID,
  secret: process.env.DISCORD_CLIENT_SECRET || appConfig.CLIENT_SECRET || "",
  panelUrl: (process.env.PANEL_URL || appConfig.PANEL_URL || `http://localhost:${process.env.WEB_PORT || appConfig.WEB_PORT || 3000}`).replace(/\/+$/, ""),
});
const redirectUri = () => `${settings().panelUrl}/oauth/callback`;
const configured = () => Boolean(settings().clientId && settings().secret);

// ---------------------------------------------------------------- token encryption

const key = () => crypto.createHash("sha256").update(`banada-oauth:${settings().secret || appConfig.DISCORD_TOKEN || ""}`).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}
function decrypt(blob) {
  const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------- OAuth flow

/** state -> { guildId, expires }: proves the callback answers a request made from the panel. */
const pending = new Map();

/** The Discord authorize URL for a server (called from the authenticated panel). */
function startUrl(guildId) {
  if (!configured()) throw new Error("Set CLIENT_SECRET in config.json first (Developer Portal → OAuth2 → Client Secret).");
  for (const [s, p] of pending) if (p.expires < Date.now()) pending.delete(s);
  const state = crypto.randomBytes(24).toString("base64url");
  pending.set(state, { guildId, expires: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: settings().clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

async function tokenRequest(body) {
  const { clientId, secret } = settings();
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Discord answered ${res.status}`);
  return data;
}

function saveUser(user, tokens) {
  db.run(
    `INSERT INTO oauth_users (user_id, username, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`,
    user.id, user.username, encrypt(tokens.access_token), encrypt(tokens.refresh_token), Date.now() + tokens.expires_in * 1000
  );
}

/**
 * Handles Discord's redirect back to <PANEL_URL>/oauth/callback. Not behind the
 * panel token (the browser arrives from Discord), so it only accepts a state it
 * issued itself in the last 10 minutes, once.
 * @returns {{ ok: boolean, message: string, guildId?: string }}
 */
async function handleCallback(client, query) {
  const state = query.get("state");
  const request = state && pending.get(state);
  pending.delete(state);
  if (!request || request.expires < Date.now()) return { ok: false, message: "This link expired or wasn't started from the panel. Start again from the Permissions page." };
  if (query.get("error")) return { ok: false, message: `Discord said: ${query.get("error_description") || query.get("error")}` };

  const tokens = await tokenRequest({ grant_type: "authorization_code", code: query.get("code"), redirect_uri: redirectUri() });
  if (!String(tokens.scope).includes("applications.commands.permissions.update"))
    return { ok: false, message: "The permissions scope wasn't granted." };
  const me = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then((r) => r.json());
  saveUser(me, tokens);
  db.run(
    `INSERT INTO oauth_guilds (guild_id, user_id, applied_json) VALUES (?, ?, '{}')
     ON CONFLICT (guild_id) DO UPDATE SET user_id = excluded.user_id, applied_json = '{}', last_error = NULL`,
    request.guildId, me.id
  );
  const result = await sync(client, request.guildId);
  return { ok: !result.error, guildId: request.guildId, message: result.error ? `Connected as ${me.username}, but syncing failed: ${result.error}` : `Connected as ${me.username}. ${result.summary}` };
}

/** A valid access token for a user, refreshing it when it's about to expire. */
async function accessToken(userId) {
  const row = db.get("SELECT * FROM oauth_users WHERE user_id = ?", userId);
  if (!row) throw new Error("Nobody is connected for this server.");
  if (row.expires_at - 60_000 > Date.now()) return decrypt(row.access_token);
  const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(row.refresh_token) });
  saveUser({ id: userId, username: row.username }, tokens);
  return tokens.access_token;
}

// ---------------------------------------------------------------- what to apply

/**
 * The overwrites each hidden command should have in a server, from the
 * Permissions page: { commandName: [{ id, type, permission: true }] }.
 */
function desiredOverwrites(client, guildId) {
  const { levels, PERMISSION_GATES } = guard;
  const assigned = db.all("SELECT target_id, kind, level FROM access_levels WHERE guild_id = ?", guildId);
  const staff = db.all("SELECT role_id FROM staff_roles WHERE guild_id = ?", guildId).map((r) => r.role_id);
  const out = {};

  for (const command of client.commands.values()) {
    const json = command.data.toJSON();
    if (!json.default_member_permissions || json.default_member_permissions === "0") continue; // visible anyway
    // Lowest level needed for any part of the command in this server (overrides included).
    const parts = command.handlers
      ? Object.entries(command.handlers).map(([k, h]) => [k ? `${json.name} ${k}` : json.name, levels.gateLevel(h.gate, PERMISSION_GATES)])
      : [[json.name, levels.bitsLevel(json.default_member_permissions)]];
    const min = Math.min(...parts.map(([path, def]) => levels.required(guildId, path, def).level));

    let entries = [];
    if (min <= levels.MEMBER) entries = [{ id: guildId, type: ApplicationCommandPermissionType.Role, permission: true }]; // @everyone
    else if (min <= levels.ADMIN) {
      for (const a of assigned)
        if (levels.LEVELS.indexOf(a.level) >= min)
          entries.push({ id: a.target_id, type: a.kind === "role" ? ApplicationCommandPermissionType.Role : ApplicationCommandPermissionType.User, permission: true });
      if (min <= levels.MOD)
        for (const roleId of staff) entries.push({ id: roleId, type: ApplicationCommandPermissionType.Role, permission: true });
    }
    const seen = new Set();
    out[json.name] = entries.filter((e) => !seen.has(e.id) && seen.add(e.id)).slice(0, MAX_OVERWRITES);
  }
  return out;
}

const hash = (entries) => crypto.createHash("sha1").update(JSON.stringify([...entries].sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");

// ---------------------------------------------------------------- sync

const running = new Map(); // guildId -> promise (one sync per server at a time)

/** Pushes the desired overwrites for one server (only the commands that changed). */
function sync(client, guildId) {
  if (running.has(guildId)) return running.get(guildId);
  const job = (async () => {
    const link = db.get("SELECT * FROM oauth_guilds WHERE guild_id = ?", guildId);
    if (!link) return { skipped: true, summary: "Not connected." };
    if (!client.application) return { error: "The bot isn't logged in yet." };
    try {
      const token = await accessToken(link.user_id);
      const commands = await client.application.commands.fetch();
      const desired = desiredOverwrites(client, guildId);
      const applied = JSON.parse(link.applied_json || "{}");
      let changed = 0;
      for (const [name, entries] of Object.entries(desired)) {
        const command = commands.find((c) => c.name === name);
        if (!command) continue; // not deployed yet
        const h = hash(entries);
        if (applied[command.id] === h) continue;
        await client.application.commands.permissions.set({ guild: guildId, command: command.id, permissions: entries, token });
        applied[command.id] = h;
        changed++;
      }
      db.run("UPDATE oauth_guilds SET applied_json = ?, last_sync_at = ?, last_error = NULL WHERE guild_id = ?", JSON.stringify(applied), Date.now(), guildId);
      return { changed, summary: changed ? `Updated who can see ${changed} command(s).` : "Everything was already up to date." };
    } catch (err) {
      const message =
        err.status === 401 || /invalid_grant/.test(err.message) ? "The connection expired or was revoked. Connect again."
        : err.status === 403 || err.code === 50013 || err.code === 50001
          ? "The connected Discord user needs Manage Server and Manage Roles in this server."
          : err.message;
      db.run("UPDATE oauth_guilds SET last_error = ?, last_sync_at = ? WHERE guild_id = ?", message, Date.now(), guildId);
      return { error: message };
    }
  })().finally(() => running.delete(guildId));
  running.set(guildId, job);
  return job;
}

/** Re-sync a few seconds after a Permissions-page change (many quick edits = one sync). */
const debounce = new Map();
function scheduleSync(client, guildId, delay = 4000) {
  if (!db.get("SELECT 1 FROM oauth_guilds WHERE guild_id = ?", guildId)) return;
  clearTimeout(debounce.get(guildId));
  debounce.set(guildId, setTimeout(() => { debounce.delete(guildId); sync(client, guildId); }, delay).unref?.() ?? null);
}

function status(guildId) {
  const link = db.get("SELECT g.*, u.username FROM oauth_guilds g LEFT JOIN oauth_users u USING (user_id) WHERE g.guild_id = ?", guildId);
  return {
    configured: configured(),
    redirectUri: redirectUri(),
    connected: Boolean(link),
    user: link?.username ?? null,
    lastSyncAt: link?.last_sync_at ?? null,
    lastError: link?.last_error ?? null,
  };
}

function disconnect(guildId) {
  db.run("DELETE FROM oauth_guilds WHERE guild_id = ?", guildId);
  db.run("DELETE FROM oauth_users WHERE user_id NOT IN (SELECT user_id FROM oauth_guilds)");
  return { ok: true };
}

/** On start-up and every 6 hours: re-sync every connected server (staff roles can change in Discord). */
let clientRef = null;
scheduler.define(SYNC_KIND, async () => {
  for (const { guild_id } of db.all("SELECT guild_id FROM oauth_guilds")) if (clientRef?.guilds.cache.has(guild_id)) await sync(clientRef, guild_id);
  return Date.now() + 6 * 3600_000;
});
function start(client) {
  clientRef = client;
  client.once("clientReady", () => scheduler.schedule(SYNC_KIND, Date.now() + 15_000, {}, { key: "all" }));
}

module.exports = { startUrl, handleCallback, sync, scheduleSync, status, disconnect, desiredOverwrites, start, configured, redirectUri, encrypt, decrypt };
