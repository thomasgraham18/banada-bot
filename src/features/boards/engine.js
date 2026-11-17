/**
 * The board engine: the pure rules shared by /starboard and /clownboard.
 *
 * Nothing in here talks to Discord, so it can be unit-tested offline
 * (engine.test.js). listeners.js gathers the facts (counts, channels, roles)
 * and asks this file what to do; db.js stores settings.
 *
 * A "kind" is "starboard" or "clownboard". Both boards behave identically;
 * only the wording, the default emoji and the default colour differ.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { parse } = require("../../core");

/** Per-kind wording and defaults. */
const KINDS = {
  starboard: { name: "starboard", title: "Starboard", noun: "star", emoji: "⭐", color: 0xffac33 },
  clownboard: { name: "clownboard", title: "Clownboard", noun: "clown", emoji: "🤡", color: 0xff5555 },
};
const KIND_NAMES = Object.keys(KINDS);

/** Defaults used when a setting is NULL in the database (never set, or cleared). */
const DEFAULTS = { threshold: 3, selfstar: false, attachments: true, jumpurl: true, timestamp: true };

/** Messages older than this don't get *new* board posts (deduced; existing posts still update). */
const MAX_AGE_MS = 14 * 86400e3;

/** Settings `/<board> clear` can reset, mapped to their database column. */
const CLEARABLE = ["emoji", "color", "channel", "threshold", "selfstar", "attachments", "jumpurl", "timestamp"];

/**
 * Database row (or undefined) + ignore rows -> the settings object listeners use.
 * NULL columns fall back to the defaults above.
 */
function resolveSettings(kind, row, ignoreRows = []) {
  const meta = KINDS[kind];
  const emoji = row?.emoji ?? meta.emoji;
  let emojiKey;
  try {
    emojiKey = parse.emojiKey(parse.emoji(emoji));
  } catch {
    emojiKey = parse.emojiKey(meta.emoji); // a stored emoji that no longer parses: fall back
  }
  const bool = (v, d) => (v === null || v === undefined ? d : Boolean(v));
  const ignores = { channel: new Set(), member: new Set(), role: new Set() };
  for (const r of ignoreRows) ignores[r.target_kind]?.add(r.target_id);
  return {
    kind,
    configured: Boolean(row),
    channelId: row?.channel_id ?? null,
    emoji,
    emojiKey,
    color: row?.color ?? meta.color,
    threshold: row?.threshold ?? DEFAULTS.threshold,
    selfstar: bool(row?.selfstar, DEFAULTS.selfstar),
    attachments: bool(row?.attachments, DEFAULTS.attachments),
    jumpurl: bool(row?.jumpurl, DEFAULTS.jumpurl),
    timestamp: bool(row?.timestamp, DEFAULTS.timestamp),
    locked: Boolean(row?.locked),
    ignores,
  };
}

/** A board does anything only when it has a channel and isn't locked. */
const isActive = (settings) => Boolean(settings?.channelId && !settings.locked);

/**
 * Counts the reactors that matter: no bots, and not the author unless selfstar is on.
 * @param {{ id: string, bot?: boolean }[]} users
 */
function countReactors(users, authorId, selfstar) {
  let n = 0;
  for (const u of users) if (!u.bot && (selfstar || u.id !== authorId)) n++;
  return n;
}

/**
 * Should this message be on the board at all? Returns null when yes, or a
 * short reason when no.
 *
 * `hasPost` = it is already on the board. Ignores and the age limit only stop
 * *new* posts (Bleed: "ignore … for new stars"); an existing post keeps its
 * count up to date. The NSFW rule always applies: an NSFW message must never
 * show in a SFW board.
 *
 * @param {object} p
 * @param {object} p.settings  resolveSettings() output
 * @param {{ channelId, parentIds?: string[], authorId, roleIds?: string[], nsfw?: boolean, createdTimestamp }} p.source
 * @param {{ channelId, nsfw?: boolean }} p.board
 */
function checkEligibility({ settings, source, board, hasPost = false, now = Date.now() }) {
  if (!isActive(settings)) return settings?.locked ? "locked" : "no channel";
  if (source.channelId === board.channelId) return "board channel";
  if (source.nsfw && !board.nsfw) return "nsfw";
  if (hasPost) return null;
  const { ignores } = settings;
  if ([source.channelId, ...(source.parentIds ?? [])].some((id) => id && ignores.channel.has(id))) return "ignored channel";
  if (ignores.member.has(source.authorId)) return "ignored member";
  if ((source.roleIds ?? []).some((id) => ignores.role.has(id))) return "ignored role";
  if (now - source.createdTimestamp > MAX_AGE_MS) return "too old";
  return null;
}

/**
 * What to do after counting:
 *   "post"   count reached the threshold and nothing is posted yet
 *   "edit"   already posted and still at/above the threshold: update the count
 *   "remove" already posted but fell below the threshold
 *   "none"   nothing to do
 *
 * Design choice (the package file lets us pick): a post whose count drops
 * below the threshold is DELETED, so the board only ever shows messages that
 * currently qualify. It is reposted if it qualifies again.
 */
function decide({ count, threshold, hasPost }) {
  if (count >= threshold) return hasPost ? "edit" : "post";
  return hasPost ? "remove" : "none";
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;
const isImage = (a) => Boolean(a?.contentType?.startsWith("image/") || IMAGE_EXT.test(a?.name ?? "") || IMAGE_EXT.test(a?.url ?? ""));
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Builds the board message.
 *
 * @param {object} settings resolveSettings() output
 * @param {number} count
 * @param {object} snap a plain snapshot of the source message (listeners.snapshot()):
 *   { id, url, channelId, content, createdTimestamp,
 *     author: { name, avatar },
 *     attachments: [{ name, url, contentType }],
 *     embeds: [{ title, description, image, thumbnail, type }],
 *     stickers: [name],
 *     reply: { name, content, url } | null }
 * @returns a message payload ({ content, embeds, components, allowedMentions })
 */
function buildPost(settings, count, snap) {
  const embed = new EmbedBuilder().setColor(settings.color).setAuthor({
    name: clip(snap.author?.name ?? "Unknown user", 256),
    iconURL: snap.author?.avatar ?? undefined,
  });

  // Text: the message content, or the first embed's text for bot/link messages.
  const firstEmbed = snap.embeds?.[0];
  let text = snap.content || [firstEmbed?.title, firstEmbed?.description].filter(Boolean).join("\n") || "";
  if (snap.stickers?.length) text += `${text ? "\n" : ""}*Sticker: ${snap.stickers.join(", ")}*`;
  if (text) embed.setDescription(clip(text, 4096));

  // Replied-to context.
  if (snap.reply) {
    const replyText = clip(snap.reply.content || "*no text*", 200);
    embed.addFields({
      name: clip(`Replying to ${snap.reply.name ?? "a message"}`, 256),
      value: snap.reply.url ? `[${replyText.replace(/[[\]]/g, "")}](${snap.reply.url})` : replyText,
    });
  }

  // Attachments: the first image becomes the embed image, the rest are links.
  if (settings.attachments) {
    const files = snap.attachments ?? [];
    const image = files.find(isImage);
    const embedImage = (snap.embeds ?? []).map((e) => e.image ?? (["image", "gifv"].includes(e.type) ? e.thumbnail : null)).find(Boolean);
    if (image) embed.setImage(image.url);
    else if (embedImage) embed.setImage(embedImage);
    const others = files.filter((f) => f !== image);
    if (others.length) {
      const lines = [];
      let length = 0;
      for (const f of others) {
        const line = `[${(f.name ?? "file").replace(/[[\]]/g, "")}](${f.url})`;
        if (length + line.length + 1 > 1024) break;
        lines.push(line);
        length += line.length + 1;
      }
      embed.addFields({ name: others.length === 1 ? "Attachment" : "Attachments", value: lines.join("\n") || `${others.length} files` });
    }
  }

  if (settings.timestamp && snap.createdTimestamp) embed.setTimestamp(snap.createdTimestamp);
  embed.setFooter({ text: snap.id });

  const components = [];
  if (settings.jumpurl && snap.url) {
    components.push(
      new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Jump to message").setURL(snap.url))
    );
  }

  return {
    content: `${settings.emoji} **${count}** <#${snap.channelId}>`,
    embeds: [embed],
    components,
    allowedMentions: { parse: [] },
  };
}

/**
 * Runs async jobs one at a time per key. A burst of reactions on one message
 * becomes a queue, so two "post" decisions can never run side by side and
 * post the message twice.
 *
 *   const run = createSerialiser();
 *   run(message.id, () => refresh(...));
 */
function createSerialiser() {
  const chains = new Map();
  const run = (key, job) => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(job, job).catch((err) => console.error(`[boards] update for ${key} failed:`, err));
    chains.set(key, next);
    // Forget the chain once it's idle so the map doesn't grow forever.
    next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };
  run.pending = () => chains.size;
  return run;
}

module.exports = {
  KINDS,
  KIND_NAMES,
  DEFAULTS,
  MAX_AGE_MS,
  CLEARABLE,
  resolveSettings,
  isActive,
  countReactors,
  checkEligibility,
  decide,
  isImage,
  buildPost,
  createSerialiser,
};
