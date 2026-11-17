/**
 * Offline tests for /starboard and /clownboard: the board rules, the embed
 * builder, the per-message queue, storage and both command trees.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-boards-test-"));
const engine = require("./engine");
const store = require("./db");
const { commandPaths } = require("../../core");
const feature = require("./index");

const GUILD = "200000000000000001";
const BOARD = "300000000000000001";
const SOURCE = "300000000000000002";
const NOW = Date.UTC(2026, 10, 17);

const settingsWith = (row = {}, ignores = []) =>
  engine.resolveSettings("starboard", { channel_id: BOARD, locked: 0, ...row }, ignores);

const source = (extra = {}) => ({ channelId: SOURCE, parentIds: [], authorId: "u1", roleIds: [], nsfw: false, createdTimestamp: NOW - 1000, ...extra });
const eligible = (settings, src = {}, board = {}, hasPost = false) =>
  engine.checkEligibility({ settings, source: source(src), board: { channelId: BOARD, nsfw: false, ...board }, hasPost, now: NOW });

// ---------------------------------------------------------------- settings

test("defaults per kind when nothing is stored", () => {
  const star = engine.resolveSettings("starboard", undefined);
  const clown = engine.resolveSettings("clownboard", undefined);
  assert.equal(star.emoji, "⭐");
  assert.equal(clown.emoji, "🤡");
  assert.equal(star.color, 0xffac33);
  assert.equal(clown.color, 0xff5555);
  assert.deepEqual(
    [star.threshold, star.selfstar, star.attachments, star.jumpurl, star.timestamp, star.locked],
    [3, false, true, true, true, false]
  );
  assert.equal(engine.isActive(star), false, "no channel = inactive");
});

test("stored values override defaults; custom emojis match by id", () => {
  const s = settingsWith({ emoji: "<:pog:123456789012345678>", threshold: 5, selfstar: 1, attachments: 0 });
  assert.equal(s.emojiKey, "123456789012345678");
  assert.equal(s.threshold, 5);
  assert.equal(s.selfstar, true);
  assert.equal(s.attachments, false);
  assert.equal(s.jumpurl, true);
  // Unicode keys ignore the variation selector, like reactions do.
  assert.equal(settingsWith({ emoji: "❤️" }).emojiKey, "❤");
});

// ---------------------------------------------------------------- rules

test("threshold: post / edit / remove decisions", () => {
  assert.equal(engine.decide({ count: 2, threshold: 3, hasPost: false }), "none");
  assert.equal(engine.decide({ count: 3, threshold: 3, hasPost: false }), "post");
  assert.equal(engine.decide({ count: 7, threshold: 3, hasPost: true }), "edit");
  assert.equal(engine.decide({ count: 2, threshold: 3, hasPost: true }), "remove");
});

test("self-star and bots are excluded from the count", () => {
  const users = [{ id: "author" }, { id: "a" }, { id: "b" }, { id: "bot", bot: true }];
  assert.equal(engine.countReactors(users, "author", false), 2);
  assert.equal(engine.countReactors(users, "author", true), 3);
  assert.equal(engine.countReactors([], "author", true), 0);
});

test("locked boards and boards without a channel do nothing", () => {
  assert.equal(eligible(settingsWith({ locked: 1 })), "locked");
  assert.equal(eligible(engine.resolveSettings("starboard", undefined)), "no channel");
  assert.equal(eligible(settingsWith()), null);
});

test("messages in the board channel itself are never boarded", () => {
  assert.equal(eligible(settingsWith(), { channelId: BOARD }), "board channel");
});

test("NSFW messages never leak into a SFW board, even when already posted", () => {
  const s = settingsWith();
  assert.equal(eligible(s, { nsfw: true }), "nsfw");
  assert.equal(eligible(s, { nsfw: true }, {}, true), "nsfw");
  assert.equal(eligible(s, { nsfw: true }, { nsfw: true }), null, "NSFW board accepts NSFW");
  assert.equal(eligible(s, { nsfw: false }, { nsfw: true }), null, "NSFW board accepts SFW");
});

test("ignored channels, categories, members and roles block new posts only", () => {
  const s = settingsWith({}, [
    { target_id: "chan", target_kind: "channel" },
    { target_id: "cat", target_kind: "channel" },
    { target_id: "bad", target_kind: "member" },
    { target_id: "muted", target_kind: "role" },
  ]);
  assert.equal(eligible(s, { channelId: "chan" }), "ignored channel");
  assert.equal(eligible(s, { parentIds: ["cat"] }), "ignored channel", "category / thread parent");
  assert.equal(eligible(s, { authorId: "bad" }), "ignored member");
  assert.equal(eligible(s, { roleIds: ["x", "muted"] }), "ignored role");
  assert.equal(eligible(s, { authorId: "bad" }, {}, true), null, "existing post keeps updating");
});

test("old messages don't get new posts", () => {
  const s = settingsWith();
  const old = { createdTimestamp: NOW - engine.MAX_AGE_MS - 1 };
  assert.equal(eligible(s, old), "too old");
  assert.equal(eligible(s, old, {}, true), null);
});

// ---------------------------------------------------------------- embed builder

const snap = (extra = {}) => ({
  id: "999",
  url: "https://discord.com/channels/1/2/999",
  channelId: SOURCE,
  content: "hello world",
  createdTimestamp: NOW,
  author: { name: "Alice", avatar: "https://cdn/a.png" },
  attachments: [],
  embeds: [],
  stickers: [],
  reply: null,
  ...extra,
});

test("buildPost: content line, author, text, colour, timestamp, jump button", () => {
  const post = engine.buildPost(settingsWith(), 4, snap());
  assert.equal(post.content, `⭐ **4** <#${SOURCE}>`);
  assert.deepEqual(post.allowedMentions, { parse: [] });
  const e = post.embeds[0].toJSON();
  assert.equal(e.author.name, "Alice");
  assert.equal(e.description, "hello world");
  assert.equal(e.color, 0xffac33);
  assert.equal(e.timestamp, new Date(NOW).toISOString());
  assert.equal(e.footer.text, "999");
  const button = post.components[0].toJSON().components[0];
  assert.equal(button.url, snap().url);
  assert.equal(button.label, "Jump to message");
});

test("buildPost: jumpurl / timestamp off", () => {
  const post = engine.buildPost(settingsWith({ jumpurl: 0, timestamp: 0 }), 3, snap());
  assert.equal(post.components.length, 0);
  assert.equal(post.embeds[0].toJSON().timestamp, undefined);
});

test("buildPost: first image is the embed image, other files are links", () => {
  const attachments = [
    { name: "notes.txt", url: "https://cdn/notes.txt", contentType: "text/plain" },
    { name: "cat.png", url: "https://cdn/cat.png", contentType: "image/png" },
    { name: "dog.jpg", url: "https://cdn/dog.jpg", contentType: null },
  ];
  const e = engine.buildPost(settingsWith(), 3, snap({ attachments })).embeds[0].toJSON();
  assert.equal(e.image.url, "https://cdn/cat.png");
  const field = e.fields.find((f) => f.name === "Attachments");
  assert.match(field.value, /\[notes\.txt\]\(https:\/\/cdn\/notes\.txt\)/);
  assert.match(field.value, /dog\.jpg/);

  const off = engine.buildPost(settingsWith({ attachments: 0 }), 3, snap({ attachments })).embeds[0].toJSON();
  assert.equal(off.image, undefined);
  assert.equal(off.fields, undefined);
});

test("buildPost: link/GIF embeds give the image; embed text fills empty content", () => {
  const e = engine.buildPost(settingsWith(), 3, snap({
    content: "",
    embeds: [{ title: "A bot embed", description: "details", type: "gifv", thumbnail: "https://media/x.gif" }],
  })).embeds[0].toJSON();
  assert.equal(e.description, "A bot embed\ndetails");
  assert.equal(e.image.url, "https://media/x.gif");
});

test("buildPost: replied-to context, long text clipped, clownboard wording", () => {
  const clown = engine.resolveSettings("clownboard", { channel_id: BOARD });
  const post = engine.buildPost(clown, 10, snap({
    content: "x".repeat(5000),
    reply: { name: "Bob", content: "original [msg]", url: "https://discord.com/channels/1/2/3" },
  }));
  assert.equal(post.content, `🤡 **10** <#${SOURCE}>`);
  const e = post.embeds[0].toJSON();
  assert.equal(e.description.length, 4096);
  assert.equal(e.fields[0].name, "Replying to Bob");
  assert.equal(e.fields[0].value, "[original msg](https://discord.com/channels/1/2/3)");
  assert.equal(e.color, 0xff5555);
});

// ---------------------------------------------------------------- queue

test("serialiser runs jobs for one message one at a time, in order", async () => {
  const run = engine.createSerialiser();
  const log = [];
  let active = 0;
  const job = (n) => async () => {
    active++;
    assert.equal(active, 1, "never two at once");
    await new Promise((r) => setTimeout(r, 5));
    log.push(n);
    active--;
  };
  const failing = async () => {
    throw new Error("boom (expected in test)");
  };
  const origError = console.error;
  console.error = () => {};
  try {
    await Promise.all([run("m", job(1)), run("m", failing), run("m", job(2)), run("m", job(3))]);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(log, [1, 2, 3], "a failing job doesn't break the chain");
  assert.equal(run.pending(), 0, "idle chains are forgotten");
});

// ---------------------------------------------------------------- storage

test("settings, clear, ignores and reset round-trip through the cache", () => {
  store.setBoard(GUILD, "starboard", { channel_id: BOARD, threshold: 7, emoji: "🔥" });
  let s = store.settings.get(GUILD).starboard;
  assert.equal(s.threshold, 7);
  assert.equal(s.emojiKey, "🔥");
  assert.equal(store.settings.get(GUILD).clownboard.configured, false, "boards are independent");

  store.clearSetting(GUILD, "starboard", "threshold");
  assert.equal(store.settings.get(GUILD).starboard.threshold, 3);

  assert.equal(store.toggleIgnore(GUILD, "starboard", "r1", "role"), true);
  assert.ok(store.settings.get(GUILD).starboard.ignores.role.has("r1"));
  assert.equal(store.toggleIgnore(GUILD, "starboard", "r1", "role"), false);
  assert.equal(store.settings.get(GUILD).starboard.ignores.role.size, 0);

  store.setBoard(GUILD, "starboard", { locked: true });
  s = store.settings.get(GUILD).starboard;
  assert.equal(s.locked, true);
  assert.equal(s.channelId, BOARD, "lock keeps the config");

  store.toggleIgnore(GUILD, "starboard", "c1", "channel");
  store.resetBoard(GUILD, "starboard");
  s = store.settings.get(GUILD).starboard;
  assert.equal(s.configured, false);
  assert.equal(s.ignores.channel.size, 0);
});

test("post mapping: save, lookup by source and board message, suppress, delete", () => {
  const row = { guild_id: GUILD, kind: "clownboard", source_message_id: "s1", source_channel_id: SOURCE, board_channel_id: BOARD, board_message_id: "b1", count: 3 };
  store.savePost(row);
  const cached = store.posts.get(GUILD);
  assert.equal(cached.bySource.get("s1")[0].board_message_id, "b1");
  assert.equal(cached.byBoard.get("b1").source_message_id, "s1");
  assert.equal(store.countPosts(GUILD, "clownboard"), 1);

  store.updateCount(GUILD, "clownboard", "s1", 9);
  assert.equal(store.getPost(GUILD, "clownboard", "s1").count, 9);

  store.suppressPost(GUILD, "b1");
  assert.equal(store.getPost(GUILD, "clownboard", "s1").board_message_id, null);
  assert.equal(store.posts.get(GUILD).byBoard.has("b1"), false);
  assert.equal(store.countPosts(GUILD, "clownboard"), 0);

  store.deletePost(GUILD, "clownboard", "s1");
  assert.equal(store.getPost(GUILD, "clownboard", "s1"), undefined);
  assert.equal(store.posts.get(GUILD).bySource.has("s1"), false);
});

// ---------------------------------------------------------------- commands

test("both command trees have 15 subcommands, all handled and gated Manage Guild", () => {
  assert.equal(feature.name, "boards");
  const names = feature.commands.map((c) => c.data.name).sort();
  assert.deepEqual(names, ["clownboard", "starboard"]);
  for (const command of feature.commands) {
    assert.deepEqual(command.validate(), []);
    const paths = commandPaths(command.data.toJSON());
    assert.equal(paths.length, 15);
    assert.ok(paths.includes("ignore toggle") && paths.includes("selfstar") && paths.includes("clear"));
    for (const p of paths) assert.equal(command.handlers[p].gate, "Manage Guild", p);
  }
  const clear = feature.commands[0].data.toJSON().options.find((o) => o.name === "clear");
  assert.deepEqual(clear.options[0].choices.map((c) => c.value), engine.CLEARABLE);
});
