/**
 * Reaction / message listeners for /starboard and /clownboard.
 *
 * Flow for any change (reaction added/removed/cleared, message edited):
 *   cheap checks against cached settings -> queue(message id, refresh)
 * refresh() fetches what's needed, recounts, and posts / edits / removes the
 * board message. The queue (engine.createSerialiser) runs one refresh per
 * source message at a time, so a burst of reactions can't post it twice.
 */
const { listeners, parse, ui } = require("../../core");
const store = require("./db");
const engine = require("./engine");

const queue = engine.createSerialiser();

/** Max reactor pages fetched (100 users each) when counting. */
const MAX_PAGES = 10;

/** A plain snapshot of a message for engine.buildPost(). */
function snapshot(message, reply) {
  const who = (m) => ({
    name: m.member?.displayName ?? m.author?.displayName ?? m.author?.username ?? "Unknown user",
    avatar: (m.member ?? m.author)?.displayAvatarURL?.() ?? null,
  });
  return {
    id: message.id,
    url: message.url,
    channelId: message.channelId,
    content: message.content ?? "",
    createdTimestamp: message.createdTimestamp,
    author: who(message),
    attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url, contentType: a.contentType })),
    embeds: message.embeds.map((e) => ({
      title: e.title, description: e.description, image: e.image?.url ?? null, thumbnail: e.thumbnail?.url ?? null, type: e.data?.type,
    })),
    stickers: [...message.stickers.values()].map((s) => s.name),
    reply: reply ? { name: who(reply).name, content: reply.content, url: reply.url } : null,
  };
}

/** Counts qualifying reactors of the board emoji on a (fetched) message. */
async function countFor(message, settings, hasPost) {
  const reaction = message.reactions.cache.find((r) => parse.emojiKey(r.emoji) === settings.emojiKey);
  if (!reaction) return 0;
  // Fast path: even counting everyone it can't reach the threshold, and there's no post to update.
  if (!hasPost && reaction.count < settings.threshold) return reaction.count;
  const users = [];
  let after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await reaction.users.fetch({ limit: 100, after });
    users.push(...batch.values());
    if (batch.size < 100) break;
    after = batch.lastKey();
  }
  return engine.countReactors(users, message.author.id, settings.selfstar);
}

async function deleteBoardMessage(client, row) {
  if (!row.board_message_id) return;
  const channel = await client.channels.fetch(row.board_channel_id).catch(() => null);
  await channel?.messages?.delete(row.board_message_id).catch(() => {});
}

/** Recounts one message for one board and syncs the board post. Always run through queue(). */
async function refresh(client, kind, partialMessage) {
  const message = partialMessage.partial ? await partialMessage.fetch().catch(() => null) : partialMessage;
  if (!message?.guild || !message.author) return;
  const guild = message.guild;
  const settings = store.settings.get(guild.id)[kind];
  if (!engine.isActive(settings)) return;

  const post = store.getPost(guild.id, kind, message.id);
  const hasPost = Boolean(post?.board_message_id);

  const board = await guild.channels.fetch(settings.channelId).catch(() => null);
  if (!board?.isTextBased()) return;

  // Facts for the eligibility rules.
  const channel = message.channel;
  const parent = channel.isThread?.() ? channel.parent : null;
  let roleIds = [];
  if (settings.ignores.role.size) {
    const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
    roleIds = member ? [...member.roles.cache.keys()] : [];
  }
  const reason = engine.checkEligibility({
    settings,
    hasPost,
    source: {
      channelId: channel.id,
      parentIds: [channel.parentId, parent?.parentId].filter(Boolean), // thread -> channel -> category
      authorId: message.author.id,
      roleIds,
      nsfw: Boolean(parent ? parent.nsfw : channel.nsfw),
      createdTimestamp: message.createdTimestamp,
    },
    board: { channelId: board.id, nsfw: Boolean(board.nsfw) },
  });
  if (reason) return;

  const count = await countFor(message, settings, hasPost);

  // A moderator removed the post earlier: keep tracking the count, never repost.
  if (post && !post.board_message_id) return store.updateCount(guild.id, kind, message.id, count);

  const action = engine.decide({ count, threshold: settings.threshold, hasPost });
  if (action === "none") return;
  if (action === "remove") {
    // Delete the row first so our own delete isn't mistaken for a moderator's.
    store.deletePost(guild.id, kind, message.id);
    return deleteBoardMessage(client, post);
  }

  const reply = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
  const payload = engine.buildPost(settings, count, snapshot(message, reply));

  if (action === "edit") {
    const boardChannel = await client.channels.fetch(post.board_channel_id).catch(() => null);
    const existing = await boardChannel?.messages?.fetch(post.board_message_id).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return store.updateCount(guild.id, kind, message.id, count);
    }
    // The board message vanished without us noticing (e.g. while offline): post a fresh one.
    store.deletePost(guild.id, kind, message.id);
  }

  const sent = await ui.safeSend(board, payload);
  if (!sent) return;
  store.savePost({
    guild_id: guild.id,
    kind,
    source_message_id: message.id,
    source_channel_id: channel.id,
    board_channel_id: board.id,
    board_message_id: sent.id,
    count,
  });
}

const tracked = (guildId, messageId, kind) =>
  (store.posts.get(guildId).bySource.get(messageId) ?? []).some((r) => r.kind === kind);

// ---------------------------------------------------------------- handlers

function onReaction(client, kind, reaction, user) {
  const guildId = reaction.message.guildId;
  if (!guildId) return;
  const settings = store.settings.get(guildId)[kind];
  if (!engine.isActive(settings)) return;
  if (parse.emojiKey(reaction.emoji) !== settings.emojiKey) return;
  if (user?.bot) return; // bot reactions never count
  // Not awaited: core/listeners runs listeners one after another, and other
  // packages shouldn't wait for our Discord fetches. The queue logs errors.
  queue(reaction.message.id, () => refresh(client, kind, reaction.message));
}

function onTrackedChange(client, kind, message) {
  if (!message?.guildId || !tracked(message.guildId, message.id, kind)) return;
  queue(message.id, () => refresh(client, kind, message));
}

function onDelete(client, message) {
  const guildId = message?.guildId;
  if (!guildId) return;
  const { bySource, byBoard } = store.posts.get(guildId);

  // The source message was deleted: delete its board posts.
  for (const row of bySource.get(message.id) ?? []) {
    queue(message.id, async () => {
      store.deletePost(guildId, row.kind, message.id);
      await deleteBoardMessage(client, row);
    });
  }
  // A board post was deleted by someone else: don't repost it.
  if (byBoard.has(message.id)) store.suppressPost(guildId, message.id);
}

module.exports = function setup() {
  for (const kind of engine.KIND_NAMES) {
    // module + event make core/listeners honour /access module|event and /ignore.
    const opts = (what) => ({ name: `boards:${kind}:${what}`, module: kind, event: kind });
    listeners.on("messageReactionAdd", opts("add"), (client, reaction, user) => onReaction(client, kind, reaction, user));
    listeners.on("messageReactionRemove", opts("remove"), (client, reaction, user) => onReaction(client, kind, reaction, user));
    listeners.on("messageReactionRemoveEmoji", opts("removeEmoji"), (client, reaction) => onReaction(client, kind, reaction, null));
    listeners.on("messageReactionRemoveAll", opts("removeAll"), (client, message) => onTrackedChange(client, kind, message));
    listeners.on("messageUpdate", opts("edit"), (client, _old, message) => onTrackedChange(client, kind, message));
  }
  // Deletion cleanup deliberately has no module/event: a disabled or ignored
  // channel must still not leave orphaned board posts behind.
  listeners.on("messageDelete", { name: "boards:delete" }, (client, message) => onDelete(client, message));
  listeners.on("messageDeleteBulk", { name: "boards:deleteBulk" }, (client, messages) => {
    for (const message of messages.values()) onDelete(client, message);
  });
};

module.exports.snapshot = snapshot;
