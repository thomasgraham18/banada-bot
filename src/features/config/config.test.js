/**
 * Offline tests for /config (no Discord). Uses a throwaway database.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-config-test-"));
const { ApplicationCommandOptionType: T, CommandInteractionOptionResolver } = require("discord.js");
const { script, UserError } = require("../../core");
const lib = require("./lib");
const store = require("./db");
const { isNewBoost } = require("./listeners");
const command = require("./commands/config");

test("the /config tree is valid and has 39 handled subcommands", () => {
  assert.deepEqual(command.validate(), []);
  assert.equal(Object.keys(command.handlers).length, 39);
  assert.equal(command.handlers["customize avatar"].gate, "Server Owner");
  assert.equal(command.handlers["webhook list"].gate, undefined); // public
});

test("pingable scripts put the mention in the content", () => {
  assert.equal(lib.withPing("Welcome!", true), "{user.mention} Welcome!");
  assert.equal(lib.withPing("Hi {user}", true), "Hi {user}");
  assert.equal(lib.withPing("Welcome!", false), "Welcome!");
  const json = JSON.parse(lib.withPing(JSON.stringify({ embed: { title: "Hi" } }), true));
  assert.equal(json.content, "{user.mention}");
  assert.equal(json.embed.title, "Hi");
  assert.deepEqual(lib.allowedMentions("5", false), { parse: [] });
  assert.deepEqual(lib.allowedMentions("5", true), { parse: [], users: ["5"] });
  // Renders with the member's mention allowed only when pingable.
  const payload = script.render(lib.withPing("Hey", true), { user: { id: "5", username: "u" }, allowedMentions: lib.allowedMentions("5", true) });
  assert.equal(payload.content, "<@5> Hey");
});

test("gallery messages need an image, video, sticker or media embed", () => {
  const msg = (o) => ({ attachments: new Map(), stickers: new Map(), embeds: [], content: "", ...o });
  assert.equal(lib.isGalleryMessage(msg({})), false);
  assert.equal(lib.isGalleryMessage(msg({ attachments: new Map([["1", { contentType: "image/png", name: "a.png" }]]) })), true);
  assert.equal(lib.isGalleryMessage(msg({ attachments: new Map([["1", { contentType: "application/pdf", name: "a.pdf" }]]) })), false);
  assert.equal(lib.isGalleryMessage(msg({ attachments: new Map([["1", { name: "clip.MP4" }]]) })), true);
  assert.equal(lib.isGalleryMessage(msg({ embeds: [{ image: { url: "x" } }] })), true);
  assert.equal(lib.isGalleryMessage(msg({ stickers: new Map([["1", {}]]) })), true);
  assert.equal(lib.mightGetEmbed(msg({ content: "look https://tenor.com/x" })), true);
  assert.equal(lib.mightGetEmbed(msg({ content: "hello" })), false);
});

test("sticky debouncer: one repost after a burst, capped by maxWait", async () => {
  const d = lib.createDebouncer({ wait: 40, maxWait: 120 });
  let runs = 0;
  for (let i = 0; i < 10; i++) d.trigger("c", async () => runs++);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(runs, 1);

  // A steady stream (every 20 ms, longer than maxWait) still fires.
  runs = 0;
  const start = Date.now();
  while (Date.now() - start < 200) {
    d.trigger("busy", async () => runs++);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(runs >= 1, "maxWait should force a run during a busy stream");
  d.cancel("busy");
  assert.equal(d.pending("busy"), false);
});

test("webhook tokens round-trip encrypted and fail closed with the wrong key", () => {
  const stored = lib.encrypt("secret-token", "key-a");
  assert.ok(!stored.includes("secret-token"));
  assert.equal(lib.decrypt(stored, "key-a"), "secret-token");
  assert.equal(lib.decrypt(stored, "key-b"), null);
  assert.equal(lib.decrypt("garbage", "key-a"), null);
  assert.match(lib.newIdentifier(), /^[0-9a-z]{6}$/);
});

test("image source: exactly one of url / attachment", () => {
  assert.throws(() => lib.pickImageSource(null, null), UserError);
  assert.equal(lib.pickImageSource(null, null, { allowNone: true }), null);
  assert.throws(() => lib.pickImageSource("https://x/a.png", { url: "y" }), UserError);
  assert.throws(() => lib.pickImageSource("not a url", null), UserError);
  assert.throws(() => lib.pickImageSource(null, { url: "y", contentType: "text/plain" }), UserError);
  assert.equal(lib.pickImageSource("https://x/a.png?v=1", null).name, "a.png");
});

test("aliases: shortcut validation, target paths and option nesting", () => {
  assert.equal(lib.validateShortcut("/Rank"), "rank");
  assert.throws(() => lib.validateShortcut("two words"), UserError);
  assert.throws(() => lib.validateShortcut(""), UserError);

  const json = command.data.toJSON();
  const paths = lib.runnablePaths(json);
  assert.equal(paths.length, 39);
  const target = paths.find((p) => p.path === "config welcome add");
  assert.deepEqual([target.group, target.sub], ["welcome", "add"]);
  const alias = lib.aliasCommandJson("wa", target);
  assert.equal(alias.name, "wa");
  assert.deepEqual(alias.options.map((o) => o.name), ["channel", "self_destruct", "pingable"]);

  // The re-nested options make a resolver that reports the original group/sub.
  const resolver = new CommandInteractionOptionResolver(null, lib.nestOptions([{ name: "self_destruct", type: T.Integer, value: 5 }], "welcome", "add"));
  assert.equal(resolver.getSubcommandGroup(), "welcome");
  assert.equal(resolver.getSubcommand(), "add");
  assert.equal(resolver.getInteger("self_destruct"), 5);
  assert.deepEqual(lib.runnablePaths({ name: "play", description: "d", options: [{ name: "q", type: T.String }] })[0].path, "play");
});

test("storage: join messages, sticky, gallery, aliases, channel cleanup", () => {
  const g = "900";
  store.joinMessages.set(g, "welcome", "c1", { script: "Hi {user}", selfDestruct: 10, pingable: true });
  store.joinMessages.set(g, "welcome", "c1", { script: "Hello", selfDestruct: null, pingable: false }); // upsert
  store.joinMessages.set(g, "boost", "c2", { script: "Thanks" });
  assert.equal(store.joinMessages.list(g, "welcome").length, 1);
  assert.equal(store.joinMessages.get(g, "welcome", "c1").script, "Hello");
  assert.equal(store.joinMessages.remove(g, "welcome", "c1"), true);
  assert.equal(store.joinMessages.remove(g, "welcome", "c1"), false);

  store.sticky.set(g, "c2", "Read the rules");
  store.sticky.setLastMessage(g, "c2", "m1");
  assert.equal(store.sticky.get(g, "c2").last_message_id, "m1");
  store.gallery.set(g, "c2", true);
  assert.deepEqual(store.gallery.get(g, "c2"), { thread: true });

  store.aliases.add(g, "rank", "levels rank", "cmd1", "u1");
  assert.equal(store.aliases.get(g, "rank").command, "levels rank");
  assert.ok(store.aliases.allShortcuts().includes("rank"));

  store.forgetChannel(g, "c2");
  assert.equal(store.sticky.get(g, "c2"), null);
  assert.equal(store.gallery.get(g, "c2"), null);
  assert.equal(store.joinMessages.list(g, "boost").length, 0);
  assert.equal(store.aliases.remove(g, "rank"), true);
});

test("boost detection", () => {
  const now = Date.now();
  assert.equal(isNewBoost({ partial: false, premiumSinceTimestamp: null }, { premiumSinceTimestamp: now }), true);
  assert.equal(isNewBoost({ partial: false, premiumSinceTimestamp: now - 1e6 }, { premiumSinceTimestamp: now - 1e6 }), false);
  assert.equal(isNewBoost({ partial: true }, { premiumSinceTimestamp: now - 5000 }), true);
  assert.equal(isNewBoost({ partial: true }, { premiumSinceTimestamp: now - 86400e3 }), false);
  assert.equal(isNewBoost({ partial: false, premiumSinceTimestamp: null }, { premiumSinceTimestamp: null }), false);
});
