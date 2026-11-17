/**
 * Pure helpers for /config (no Discord connection needed), so they can be
 * unit-tested: pingable scripts, gallery checks, the sticky debouncer, token
 * encryption, image inputs and alias command building.
 */
const crypto = require("node:crypto");
const { ApplicationCommandOptionType: T } = require("discord.js");
const { UserError, script } = require("../../core");

// ---------------------------------------------------------------- join messages

/**
 * `pingable`: Discord only pings mentions in the message content (never in
 * embeds), and core's renderer allows the member's mention. So for pingable
 * messages we make sure the content starts with {user.mention}; for the
 * rest, sendOptions() turns pings off entirely.
 */
function withPing(stored, pingable) {
  if (!pingable) return stored;
  const data = script.parseScript(stored);
  const content = String(data.content ?? "");
  if (/\{user(\.mention)?\}/i.test(content)) return stored;
  if (!script.looksLikeJson(stored)) return `{user.mention} ${content}`.trim();
  return JSON.stringify({ ...data, content: `{user.mention} ${content}`.trim() });
}

/** allowedMentions for a join message about `userId`. */
const allowedMentions = (userId, pingable) => (pingable ? { parse: [], users: [userId] } : { parse: [] });

/** Variables documented in /config welcome|goodbye|boosts view. */
const JOIN_VARIABLES = "`{user}` `{user.mention}` `{user.name}` `{user.display_name}` `{user.avatar}` `{user.join_position}` " +
  "`{guild.name}` `{guild.count}` `{guild.count.ordinal}` `{guild.boost_count}` `{guild.boost_tier}` `{channel}`";

// ---------------------------------------------------------------- gallery

const URL_PATTERN = /https?:\/\/\S+/i;
const MEDIA_TYPES = /^(image|video)\//i;
const MEDIA_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov)(\?|$)/i;

/**
 * True when a message counts as an image post: a media attachment, a sticker,
 * or an embed with an image / thumbnail / video. Plain text (or text with
 * only non-media files) does not.
 */
function isGalleryMessage(message) {
  const attachments = [...(message.attachments?.values?.() ?? message.attachments ?? [])];
  if (attachments.some((a) => MEDIA_TYPES.test(a.contentType ?? "") || MEDIA_EXTENSIONS.test(a.name ?? a.url ?? ""))) return true;
  if ((message.stickers?.size ?? message.stickers?.length ?? 0) > 0) return true;
  return (message.embeds ?? []).some((e) => e.image || e.thumbnail || e.video || e.data?.image || e.data?.thumbnail || e.data?.video);
}

/** Links get their embed a moment after the message is created; wait and re-check. */
const mightGetEmbed = (message) => URL_PATTERN.test(message.content ?? "");

// ---------------------------------------------------------------- sticky debouncer

/**
 * Trailing debounce with a ceiling. trigger(key, fn) runs fn `wait` ms after
 * the LAST trigger for that key, but never later than `maxWait` ms after the
 * FIRST trigger of a burst, so a non-stop busy channel still gets reposts.
 * fn never runs twice at once for a key; a trigger during a run queues one more run.
 */
function createDebouncer({ wait = 4000, maxWait = 12000 } = {}) {
  const state = new Map(); // key -> { timer, first, fn, running, again }

  const fire = async (key) => {
    const s = state.get(key);
    if (!s) return;
    clearTimeout(s.timer);
    s.timer = null;
    if (s.running) {
      s.again = true;
      return;
    }
    s.running = true;
    try {
      await s.fn();
    } catch (err) {
      console.error(`[config:debounce] ${key} failed:`, err);
    } finally {
      s.running = false;
      if (s.again) {
        s.again = false;
        s.first = Date.now();
        s.timer = setTimeout(() => fire(key), wait);
      } else if (!s.timer) state.delete(key);
    }
  };

  return {
    trigger(key, fn) {
      const now = Date.now();
      let s = state.get(key);
      if (!s) state.set(key, (s = { timer: null, first: now, fn, running: false, again: false }));
      if (!s.timer && !s.running) s.first = now;
      s.fn = fn;
      if (s.running) {
        s.again = true;
        return;
      }
      clearTimeout(s.timer);
      const delay = Math.max(0, Math.min(wait, s.first + maxWait - now));
      s.timer = setTimeout(() => fire(key), delay);
    },
    cancel(key) {
      const s = state.get(key);
      if (s) clearTimeout(s.timer);
      state.delete(key);
    },
    pending: (key) => Boolean(state.get(key)?.timer),
  };
}

// ---------------------------------------------------------------- webhook tokens

/**
 * Webhook tokens are stored with AES-256-GCM. The key comes from
 * WEBHOOK_SECRET when set, otherwise from the bot token (so a stolen
 * database alone doesn't reveal them). If the key changes, decrypt() returns
 * null and the caller re-fetches the token from Discord.
 */
const keyFrom = (secret) => crypto.createHash("sha256").update(`banada-webhooks:${secret}`).digest();

function encrypt(text, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

function decrypt(stored, secret) {
  try {
    const [version, iv, tag, data] = String(stored).split(":");
    if (version !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A short, readable webhook identifier such as "k3x9q2". */
const newIdentifier = () => crypto.randomBytes(4).readUInt32BE(0).toString(36).padStart(6, "0").slice(-6);

// ---------------------------------------------------------------- images

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

/** `url` + `attachment` options: exactly one of them. Returns { url, name }. */
function pickImageSource(url, attachment, { allowNone = false } = {}) {
  if (url && attachment) throw new UserError("Give either a `url` or an `attachment`, not both.");
  if (!url && !attachment) {
    if (allowNone) return null;
    throw new UserError("Give an image `url` or upload an `attachment`.");
  }
  if (attachment) {
    if (attachment.contentType && !IMAGE_TYPES.test(attachment.contentType))
      throw new UserError("That attachment isn't a PNG, JPEG, GIF or WebP image.");
    return { url: attachment.url, name: attachment.name, size: attachment.size };
  }
  if (!/^https?:\/\/\S+$/i.test(url)) throw new UserError("That isn't a valid http(s) URL.");
  return { url, name: url.split("?")[0].split("/").pop() };
}

/**
 * Downloads an image (the "download" step before guild.edit / editMe) and
 * checks its type and size. Returns { buffer, animated }.
 */
async function downloadImage(source, { maxBytes = 10 * 1024 * 1024 } = {}) {
  if (source.size && source.size > maxBytes) throw new UserError(`That image is too large (max ${Math.round(maxBytes / 1048576)} MB).`);
  let res;
  try {
    res = await fetch(source.url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  } catch {
    throw new UserError("I couldn't download that image.");
  }
  if (!res.ok) throw new UserError(`I couldn't download that image (HTTP ${res.status}).`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!IMAGE_TYPES.test(type)) throw new UserError("That link isn't a PNG, JPEG, GIF or WebP image.");
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new UserError(`That image is too large (max ${Math.round(maxBytes / 1048576)} MB).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new UserError(`That image is too large (max ${Math.round(maxBytes / 1048576)} MB).`);
  return { buffer, animated: /gif/i.test(type) };
}

// ---------------------------------------------------------------- aliases

const SHORTCUT = /^[a-z0-9_-]{1,32}$/;

function validateShortcut(text) {
  const shortcut = String(text ?? "").trim().toLowerCase().replace(/^\//, "");
  if (!SHORTCUT.test(shortcut)) throw new UserError("Shortcuts are 1-32 characters: lowercase letters, numbers, `-` and `_`.");
  return shortcut;
}

/** Every runnable path of a command JSON: "levels rank", "play"... */
function runnablePaths(json) {
  const out = [];
  // Commands such as /embedjson rely on Discord's default_member_permissions
  // alone, so an alias must carry it too or anyone could run them through it.
  const permissions = json.default_member_permissions ?? null;
  const subs = (json.options ?? []).filter((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup);
  if (!subs.length) return [{ path: json.name, group: null, sub: null, options: json.options ?? [], description: json.description, permissions }];
  for (const opt of subs) {
    if (opt.type === T.SubcommandGroup)
      for (const sub of opt.options ?? []) out.push({ path: `${json.name} ${opt.name} ${sub.name}`, group: opt.name, sub: sub.name, options: sub.options ?? [], description: sub.description, permissions });
    else out.push({ path: `${json.name} ${opt.name}`, group: null, sub: opt.name, options: opt.options ?? [], description: opt.description, permissions });
  }
  return out;
}

/** The guild application command JSON for an alias of `target` (from runnablePaths). */
const aliasCommandJson = (shortcut, target) => ({
  name: shortcut,
  description: `Alias for /${target.path}`.slice(0, 100),
  type: 1,
  options: structuredClone(target.options),
  default_member_permissions: target.permissions ?? null,
});

/**
 * Re-nests an alias interaction's options under the target's group and
 * subcommand, so the target command's router sees "/levels rank".
 */
function nestOptions(data, group, sub) {
  let options = [...data];
  if (sub) options = [{ name: sub, type: T.Subcommand, options }];
  if (group) options = [{ name: group, type: T.SubcommandGroup, options }];
  return options;
}

module.exports = {
  withPing,
  allowedMentions,
  JOIN_VARIABLES,
  isGalleryMessage,
  mightGetEmbed,
  createDebouncer,
  encrypt,
  decrypt,
  newIdentifier,
  pickImageSource,
  downloadImage,
  validateShortcut,
  runnablePaths,
  aliasCommandJson,
  nestOptions,
};
