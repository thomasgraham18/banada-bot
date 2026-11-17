/**
 * Suggestion workflows that talk to Discord: creating, publishing, editing
 * the embed after a change, and DMing the author. Commands and the
 * persistent buttons (components.js) both go through here.
 */
const { PermissionFlagsBits: P } = require("discord.js");
const { guard, UserError } = require("../../core");
const store = require("./db");
const render = require("./render");

const SEND_PERMS = [P.ViewChannel, P.SendMessages, P.EmbedLinks];
const THREAD_PERMS = [P.CreatePublicThreads, P.SendMessagesInThreads];

const messageLink = (guildId, row) =>
  row.channel_id && row.message_id ? `https://discord.com/channels/${guildId}/${row.channel_id}/${row.message_id}` : null;

/** A channel from the cache or the API, or null if it's gone. */
async function getChannel(guild, channelId) {
  if (!channelId) return null;
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
}

/** The configured channel, checked for the bot's send permissions. Throws a UserError. */
async function requireChannel(guild, channelId, label) {
  const channel = await getChannel(guild, channelId);
  if (!channel?.isTextBased?.()) throw new UserError(`The ${label} isn't set (or was deleted). Ask a server manager to run \`/suggest ${label === "review channel" ? "review channel" : "set"}\`.`);
  guard.assertBotPermissions(channel, SEND_PERMS);
  return channel;
}

/** The current message payload for a suggestion row. */
function payloadFor(guildId, row) {
  return render.buildMessage(row, {
    replies: store.latestReplies(guildId, row.id, render.MAX_SHOWN_REPLIES),
    replyCount: store.countReplies(guildId, row.id),
    votes: store.voteCounts(guildId, row.id),
    settings: store.getSettings(guildId),
  });
}

/**
 * Re-renders the suggestion's message after a change.
 * Returns false when the message is gone (the DB change still stands).
 */
async function refresh(guild, row) {
  const channel = await getChannel(guild, row.channel_id);
  const message = await channel?.messages?.fetch(row.message_id).catch(() => null);
  if (!message) return false;
  await message.edit(payloadFor(guild.id, row));
  return true;
}

/** Starts a discussion thread on a public suggestion if threads are on and allowed. */
async function maybeThread(message, row, settings) {
  if (!settings.threads || !message.channel?.threads) return null;
  const perms = message.channel.permissionsFor(message.guild.members.me);
  if (!perms?.has(THREAD_PERMS)) return null;
  const name = `Suggestion #${row.id}: ${row.content.replace(/\s+/g, " ")}`.slice(0, 100);
  return message.startThread({ name, reason: `Discussion for suggestion #${row.id}` }).catch((err) => {
    console.warn(`[suggest] couldn't create thread for #${row.id}: ${err.message}`);
    return null;
  });
}

/** Posts a suggestion to the public suggestions channel (status must not be "review"). */
async function publish(guild, row) {
  const settings = store.getSettings(guild.id);
  const channel = await requireChannel(guild, settings.channel_id, "suggestions channel");
  const message = await channel.send(payloadFor(guild.id, row));
  store.setLocation(guild.id, row.id, channel.id, message.id);
  const thread = await maybeThread(message, row, settings);
  return { message, thread };
}

/** Why `member` can't suggest right now, or null. */
function blockReason(member) {
  const settings = store.getSettings(member.guild.id);
  if (settings.locked) return "Suggestions are currently locked in this server.";
  if (!settings.channel_id) return "Suggestions aren't set up yet. Ask a server manager to run `/suggest set`.";
  if (settings.review_enabled && !settings.review_channel_id)
    return "Suggestion review is on but no review channel is set. Ask a server manager to run `/suggest review channel`.";
  if (store.isIgnoredId(member.guild.id, member.id)) return "You aren't allowed to create suggestions here.";
  for (const roleId of member.roles.cache.keys())
    if (store.isIgnoredId(member.guild.id, roleId)) return "You aren't allowed to create suggestions here.";
  return null;
}

/**
 * /suggest create. Returns { row, message, thread, review }.
 * The DB row is created first (it allocates the #number); if posting fails
 * the row is removed again so numbers aren't wasted on errors.
 */
async function submit(member, content) {
  const reason = blockReason(member);
  if (reason) throw new UserError(reason);
  const guild = member.guild;
  const settings = store.getSettings(guild.id);
  const review = Boolean(settings.review_enabled);

  // Check channels before allocating a number.
  const target = review
    ? await requireChannel(guild, settings.review_channel_id, "review channel")
    : await requireChannel(guild, settings.channel_id, "suggestions channel");

  const row = store.createSuggestion(guild.id, {
    authorId: member.id,
    authorName: member.user.tag ?? member.user.username,
    authorAvatar: member.displayAvatarURL?.() ?? member.user.displayAvatarURL?.(),
    content,
    status: review ? "review" : "pending",
  });

  try {
    if (review) {
      const message = await target.send(payloadFor(guild.id, row));
      store.setLocation(guild.id, row.id, target.id, message.id);
      return { row, message, thread: null, review };
    }
    const { message, thread } = await publish(guild, row);
    return { row, message, thread, review };
  } catch (err) {
    store.deleteSuggestion(guild.id, row.id);
    throw err;
  }
}

/** DMs the author. Never throws (closed DMs are common). Returns true if sent. */
async function notifyAuthor(client, guild, row, { title, text }) {
  const user = await client.users.fetch(row.author_id).catch(() => null);
  if (!user) return false;
  const embed = render.buildNotice(row, guild.name, { title, text, link: messageLink(guild.id, row) });
  return user.send({ embeds: [embed] }).then(() => true, () => false);
}

/** Loads a suggestion for a staff command, or throws a UserError. */
function requireSuggestion(guildId, id) {
  const row = store.getSuggestion(guildId, id);
  if (!row) throw new UserError(`There is no suggestion #${id}.`);
  return row;
}

/**
 * Review channel "Approve": publish it with status Pending and turn the
 * review copy into a record of who approved it.
 */
async function approveReview(guild, row, staff) {
  store.setStatus(guild.id, row.id, "pending", null);
  const published = { ...row, status: "pending", updated_by: null };
  const reviewChannelId = row.channel_id;
  const reviewMessageId = row.message_id;
  let result;
  try {
    result = await publish(guild, published);
  } catch (err) {
    store.setStatus(guild.id, row.id, "review", null); // put it back in the queue
    throw err;
  }
  const fresh = store.getSuggestion(guild.id, row.id);
  return { row: fresh, ...result, reviewChannelId, reviewMessageId, staff };
}

module.exports = {
  SEND_PERMS,
  THREAD_PERMS,
  messageLink,
  getChannel,
  payloadFor,
  refresh,
  publish,
  blockReason,
  submit,
  notifyAuthor,
  requireSuggestion,
  approveReview,
};
