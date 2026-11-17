/**
 * Message scripts: the one format every customisable message uses (welcome,
 * goodbye, boost, jail, level-up, sticky, timers, bump reminders, invoke DMs,
 * badges, leaderboards...).
 *
 * A script is stored as a string and is either
 *   - plain text  -> sent as the message content, or
 *   - JSON        -> {
 *        "content": "Welcome {user.mention}!",
 *        "embed": {                      // or "embeds": [ ... ] (max 10)
 *          "title", "description", "url", "color": "#ff8800" | 16746496,
 *          "author": { "name", "icon_url", "url" },
 *          "footer": { "text", "icon_url" },
 *          "thumbnail": "url", "image": "url",
 *          "fields": [ { "name", "value", "inline" } ],
 *          "timestamp": true
 *        },
 *        "buttons": [ { "label", "url", "emoji" } ]   // link buttons, max 5
 *      }
 *
 * Variables like {user.mention} are replaced in every string. ctx supplies the
 * objects; features add their own keys through ctx.vars:
 *
 *   script.render(stored, { member, guild, channel, vars: { level: 5 } })
 *
 * Unknown variables are left as-is so typos are visible in previews.
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { UserError } = require("./errors");
const parse = require("./parse");

const VARIABLE = /\{([a-z0-9_.]+)\}/gi;

/** Documentation for /help-style listings and the modal placeholder. */
const BASE_VARIABLES = {
  "{user}": "Mention of the member",
  "{user.mention}": "Mention of the member",
  "{user.name}": "Username",
  "{user.display_name}": "Server display name",
  "{user.id}": "User ID",
  "{user.avatar}": "Avatar URL",
  "{user.created_at}": "Account creation (relative timestamp)",
  "{user.joined_at}": "Server join date (relative timestamp)",
  "{user.join_position}": "Nth member to join",
  "{guild.name}": "Server name",
  "{guild.id}": "Server ID",
  "{guild.count}": "Member count",
  "{guild.icon}": "Server icon URL",
  "{guild.boost_count}": "Number of boosts",
  "{guild.boost_tier}": "Boost level",
  "{channel}": "Mention of the channel",
  "{channel.name}": "Channel name",
  "{channel.id}": "Channel ID",
  "{date}": "Current date",
  "{time}": "Current time",
};

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** Builds the variable map from ctx { member | user, guild, channel, vars }. */
function variables(ctx = {}) {
  const member = ctx.member ?? null;
  const user = ctx.user ?? member?.user ?? null;
  const guild = ctx.guild ?? member?.guild ?? null;
  const channel = ctx.channel ?? null;
  const now = new Date();
  const map = {};

  if (user) {
    Object.assign(map, {
      user: `<@${user.id}>`,
      "user.mention": `<@${user.id}>`,
      "user.name": user.username,
      "user.tag": user.tag ?? user.username,
      "user.display_name": member?.displayName ?? user.globalName ?? user.username,
      "user.id": user.id,
      "user.avatar": user.displayAvatarURL?.({ size: 512 }) ?? "",
      "user.created_at": parse.timestamp(user.createdAt ?? now),
      "user.bot": user.bot ? "yes" : "no",
    });
  }
  if (member?.joinedAt) map["user.joined_at"] = parse.timestamp(member.joinedAt);
  if (member && guild) {
    // Approximate join position from the member cache.
    const position = guild.members.cache.filter((m) => m.joinedTimestamp && m.joinedTimestamp <= member.joinedTimestamp).size;
    map["user.join_position"] = ordinal(position || guild.memberCount);
  }
  if (guild) {
    Object.assign(map, {
      "guild.name": guild.name,
      "guild.id": guild.id,
      "guild.count": String(guild.memberCount),
      "guild.count.ordinal": ordinal(guild.memberCount),
      "guild.icon": guild.iconURL?.({ size: 512 }) ?? "",
      "guild.boost_count": String(guild.premiumSubscriptionCount ?? 0),
      "guild.boost_tier": String(guild.premiumTier ?? 0),
      "guild.owner_id": guild.ownerId,
    });
  }
  if (channel) Object.assign(map, { channel: `<#${channel.id}>`, "channel.name": channel.name, "channel.id": channel.id });
  map.date = now.toLocaleDateString("en-CA");
  map.time = now.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });

  for (const [k, v] of Object.entries(ctx.vars ?? {})) map[k] = v == null ? "" : String(v);
  return map;
}

function substitute(text, vars) {
  return String(text).replace(VARIABLE, (whole, key) => (key.toLowerCase() in vars ? vars[key.toLowerCase()] : whole));
}

/**
 * A script is JSON when it starts with `{"` or `{}` (whitespace allowed), so
 * plain text that starts with a variable ("{user.mention} welcome!") stays text.
 */
const looksLikeJson = (text) => /^\{\s*("|\})/.test(String(text ?? "").trim());

/** Parses a stored script. Plain text becomes { content }. */
function parseScript(script) {
  const text = String(script ?? "").trim();
  if (!looksLikeJson(text)) return { content: text };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    return data;
  } catch (err) {
    throw new UserError(`That script is not valid JSON (${err.message}). Plain text also works.`);
  }
}

const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s ?? ""));

function buildEmbed(raw, sub) {
  const e = new EmbedBuilder();
  const str = (v, max) => (v == null || v === "" ? null : sub(v).slice(0, max));
  if (str(raw.title, 256)) e.setTitle(str(raw.title, 256));
  if (str(raw.description, 4096)) e.setDescription(str(raw.description, 4096));
  if (isUrl(sub(raw.url ?? ""))) e.setURL(sub(raw.url));
  const colour = raw.color ?? raw.colour;
  if (colour !== undefined && colour !== "") e.setColor(typeof colour === "number" ? colour : parse.colour(sub(colour)));
  if (raw.author?.name)
    e.setAuthor({ name: str(raw.author.name, 256), iconURL: isUrl(sub(raw.author.icon_url ?? "")) ? sub(raw.author.icon_url) : undefined, url: isUrl(sub(raw.author.url ?? "")) ? sub(raw.author.url) : undefined });
  if (raw.footer?.text)
    e.setFooter({ text: str(raw.footer.text, 2048), iconURL: isUrl(sub(raw.footer.icon_url ?? "")) ? sub(raw.footer.icon_url) : undefined });
  const thumb = sub(raw.thumbnail?.url ?? raw.thumbnail ?? "");
  if (isUrl(thumb)) e.setThumbnail(thumb);
  const image = sub(raw.image?.url ?? raw.image ?? "");
  if (isUrl(image)) e.setImage(image);
  if (Array.isArray(raw.fields))
    e.addFields(raw.fields.slice(0, 25).filter((f) => f?.name && f?.value).map((f) => ({ name: str(f.name, 256), value: str(f.value, 1024), inline: Boolean(f.inline) })));
  if (raw.timestamp) e.setTimestamp(raw.timestamp === true ? new Date() : new Date(raw.timestamp));
  return e;
}

/**
 * Renders a script into a message payload ({ content, embeds, components }).
 * Mentions are limited to the member the message is about (no @everyone).
 */
function render(script, ctx = {}) {
  const data = parseScript(script);
  const vars = variables(ctx);
  const sub = (v) => substitute(v, vars);

  const payload = { content: data.content ? sub(data.content).slice(0, 2000) : undefined, embeds: [], components: [] };
  const rawEmbeds = Array.isArray(data.embeds) ? data.embeds : data.embed ? [data.embed] : [];
  payload.embeds = rawEmbeds.slice(0, 10).map((raw) => buildEmbed(raw, sub)).filter((e) => Object.keys(e.data).length);

  const buttons = (Array.isArray(data.buttons) ? data.buttons : []).slice(0, 5).filter((b) => b?.label && isUrl(sub(b.url ?? "")));
  if (buttons.length)
    payload.components.push(
      new ActionRowBuilder().addComponents(
        buttons.map((b) => {
          const button = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(sub(b.label).slice(0, 80)).setURL(sub(b.url));
          if (b.emoji) button.setEmoji(b.emoji);
          return button;
        })
      )
    );

  if (!payload.content && !payload.embeds.length) payload.content = "​"; // never send an empty message
  const userId = ctx.member?.id ?? ctx.user?.id;
  payload.allowedMentions = ctx.allowedMentions ?? { parse: [], users: userId ? [userId] : [] };
  return payload;
}

/** Throws UserError if the script can't be rendered (call before saving). */
function validate(script) {
  render(script, {});
  return String(script).trim();
}

/** A sample context for previews (`view` subcommands) from the invoking member. */
const previewContext = (interaction, vars = {}) => ({
  member: interaction.member,
  guild: interaction.guild,
  channel: interaction.channel,
  vars,
});

/**
 * Sends a rendered script. selfDestruct (seconds) deletes the message later
 * through the scheduler, so it survives restarts.
 */
async function send(channel, script, ctx = {}, { selfDestruct } = {}) {
  const message = await channel.send(render(script, { channel, ...ctx }));
  if (selfDestruct > 0) require("./scheduler").deleteMessageLater(message, selfDestruct * 1000);
  return message;
}

// ---------------------------------------------------------------- modal

/**
 * A modal that collects a script. Simple messages use the content/title/
 * description/colour/image fields; anything fancier can be pasted as JSON
 * into "Message" (it starts with "{").
 */
function modal(customId, title, current) {
  let data = {};
  try {
    data = current ? parseScript(current) : {};
  } catch {
    data = { content: current };
  }
  const embed = data.embed ?? data.embeds?.[0] ?? {};
  const simple = !data.embeds?.length && !data.buttons?.length && !embed.fields?.length && !embed.author && !embed.footer && !embed.thumbnail && !embed.url;

  const field = (id, label, style, value, placeholder, max) => {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(false).setMaxLength(max);
    if (value) input.setValue(String(value).slice(0, max));
    if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
    return new ActionRowBuilder().addComponents(input);
  };

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      field("content", "Message (plain text, or full JSON script)", TextInputStyle.Paragraph,
        simple ? data.content : current, "Welcome {user.mention} to {guild.name}!", 4000),
      field("title", "Embed title", TextInputStyle.Short, simple ? embed.title : "", "Optional", 256),
      field("description", "Embed description", TextInputStyle.Paragraph, simple ? embed.description : "", "Optional. Variables like {user.name} work here.", 4000),
      field("color", "Embed colour", TextInputStyle.Short, simple && embed.color != null ? (typeof embed.color === "number" ? parse.hex(embed.color) : embed.color) : "", "#5865F2 or red", 20),
      field("image", "Embed image URL", TextInputStyle.Short, simple ? embed.image?.url ?? embed.image : "", "https://...", 500)
    );
}

/** Turns a submitted script modal back into a stored script string. */
function fromModal(submit) {
  const get = (id) => submit.fields.getTextInputValue(id)?.trim() ?? "";
  const content = get("content");
  if (looksLikeJson(content)) return validate(content);

  const embed = {};
  if (get("title")) embed.title = get("title");
  if (get("description")) embed.description = get("description");
  if (get("color")) embed.color = parse.hex(parse.colour(get("color")));
  if (get("image")) embed.image = get("image");

  if (!Object.keys(embed).length) {
    if (!content) throw new UserError("The message is empty.");
    return content;
  }
  return validate(JSON.stringify(content ? { content, embed } : { embed }));
}

module.exports = {
  render,
  validate,
  looksLikeJson,
  variables,
  substitute,
  parseScript,
  previewContext,
  send,
  modal,
  fromModal,
  BASE_VARIABLES,
};
