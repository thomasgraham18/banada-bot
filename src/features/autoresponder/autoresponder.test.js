/**
 * Offline tests for /autoresponder and /reaction: trigger matching,
 * cooldowns, exclusive / no-self-react rules, and the db caches.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-autoresponder-test-"));
const { Collection } = require("discord.js");
const matcher = require("./matcher");
const { Cooldowns } = require("./cooldown");
const store = require("./db");
const { exclusiveAllows, isPunishableSelfReact } = require("./listeners");

const GUILD = "200000000000000001";

// ---------------------------------------------------------------- matcher

test("normalise lower-cases and collapses whitespace", () => {
  assert.equal(matcher.normalise("  Hello \n  WORLD  "), "hello world");
});

test("cleanTrigger validates triggers", () => {
  assert.equal(matcher.cleanTrigger("  Good   Morning "), "good morning");
  assert.equal(matcher.cleanTrigger("hi**"), "hi*");
  assert.throws(() => matcher.cleanTrigger("   "));
  assert.throws(() => matcher.cleanTrigger("***"));
  assert.throws(() => matcher.cleanTrigger("x".repeat(101)));
});

test("modeOf picks the mode from strict and wildcards", () => {
  assert.equal(matcher.modeOf("hello"), "word");
  assert.equal(matcher.modeOf("hello", true), "exact");
  assert.equal(matcher.modeOf("hi*"), "starts");
  assert.equal(matcher.modeOf("*bye"), "ends");
  assert.equal(matcher.modeOf("*lol*"), "contains");
  assert.equal(matcher.modeOf("good * day"), "wildcard");
  assert.equal(matcher.modeOf("*a*b*"), "wildcard");
  assert.equal(matcher.modeOf("hi*", true), "starts"); // wildcards win over strict
});

test("word mode: whole words anywhere, case-insensitive", () => {
  const m = (t, text) => matcher.matches(t, false, text);
  assert.ok(m("hello", "Hello there"));
  assert.ok(m("hello", "well, HELLO!"));
  assert.ok(m("hello", "hello"));
  assert.ok(!m("hello", "othello"));
  assert.ok(!m("hello", "helloo"));
  assert.ok(!m("hello", "hello_world")); // _ is a word character
  assert.ok(m("good morning", "good   morning everyone")); // whitespace collapsed
  assert.ok(!m("good morning", "goodmorning"));
});

test("word mode boundaries are Unicode-aware and only on word edges", () => {
  const m = (t, text) => matcher.matches(t, false, text);
  assert.ok(m("café", "un café svp"));
  assert.ok(!m("café", "cafés"));
  assert.ok(m("привет", "Привет всем"));
  assert.ok(!m("привет", "приветик"));
  assert.ok(m(":)", "nice :)"));
  assert.ok(m(":)", "nice:)")); // no boundary needed next to punctuation
  assert.ok(m("w", "W"));
  assert.ok(!m("w", "what"));
  assert.ok(m("c++", "I like c++ a lot")); // regex characters are escaped
  assert.ok(!m("c++", "I like cxx"));
  assert.ok(m("hello", "**hello**")); // markdown around the word
});

test("exact (strict) mode needs the whole message", () => {
  const m = (t, text) => matcher.matches(t, true, text);
  assert.ok(m("hello", "  HELLO "));
  assert.ok(!m("hello", "hello there"));
  assert.ok(!m("hello", "oh hello"));
});

test("starts / ends / contains / wildcard", () => {
  const m = (t, text) => matcher.matches(t, false, text);
  assert.ok(m("hi*", "hiya"));
  assert.ok(m("hi*", "Hi there"));
  assert.ok(m("hi*", "hi"));
  assert.ok(!m("hi*", "oh hi"));

  assert.ok(m("*bye", "goodbye"));
  assert.ok(m("*bye", "BYE"));
  assert.ok(!m("*bye", "bye now"));

  assert.ok(m("*lol*", "lollipop"));
  assert.ok(m("*lol*", "trololol"));
  assert.ok(!m("*lol*", "lo l"));

  assert.ok(m("good * day", "good sunny day"));
  assert.ok(m("good*day", "goodday"));
  assert.ok(!m("good * day", "a good sunny day"));
  assert.ok(m("*good*day*", "a good sunny day!"));
  assert.ok(m("is it *?", "is it friday?")); // "?" is literal, only * is special
  assert.ok(!m("is it *?", "is it friday"));
  assert.ok(m("a*", "a\nb")); // * crosses lines
});

test("compile: exact Map + combined regex, all matches, specific first", () => {
  const entries = [
    { trigger: "hello", strict: true, id: "exact" },
    { trigger: "hello", strict: false, id: "word" },
    { trigger: "hello there", strict: false, id: "phrase" },
    { trigger: "*ell*", strict: false, id: "contains" },
    { trigger: "bye*", strict: false, id: "starts" },
  ];
  const c = matcher.compile(entries);
  assert.equal(c.size, 5);
  assert.deepEqual(c.match("HELLO").map((e) => e.id), ["exact", "word", "contains"]);
  assert.deepEqual(c.match("hello there").map((e) => e.id), ["phrase", "word", "contains"]);
  assert.deepEqual(c.match("byebye").map((e) => e.id), ["starts"]);
  assert.deepEqual(c.match("nothing to see"), []);
  assert.deepEqual(c.match(""), []);
  assert.deepEqual(matcher.compile([]).match("hello"), []);
});

test("compile handles many triggers quickly", () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ trigger: `word${i}` }));
  const c = matcher.compile(entries);
  const text = "lorem ipsum dolor sit amet ".repeat(40);
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) c.match(text);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 2000, `1000 non-matching messages took ${ms}ms`);
  assert.deepEqual(c.match("say word42 now").map((e) => e.trigger), ["word42"]);
  assert.deepEqual(c.match("word4"), [{ trigger: "word4" }]); // not word42/word400...
});

test("looksLikeCommand", () => {
  for (const t of ["!play song", "?help", ".ban x", ";rank", ",fm", "$bal", "  !cmd"]) assert.ok(matcher.looksLikeCommand(t), t);
  for (const t of ["hello", "!!!", "...", "? what", "!1", ":)"]) assert.ok(!matcher.looksLikeCommand(t), t);
});

// ---------------------------------------------------------------- cooldowns

test("cooldowns block repeats until they expire", () => {
  const cd = new Cooldowns(1000);
  assert.ok(cd.take("a", 0));
  assert.ok(!cd.take("a", 500));
  assert.ok(cd.take("b", 500)); // other keys are independent
  assert.equal(cd.remaining("a", 600), 400);
  assert.ok(!cd.take("a", 999));
  assert.ok(cd.take("a", 1000));
  assert.ok(cd.take("c", 0, 50)); // per-call length
  assert.ok(cd.take("c", 50));
});

test("cooldowns sweep expired keys to stay bounded", () => {
  const cd = new Cooldowns(10, { max: 100 });
  for (let i = 0; i < 100; i++) cd.take(`k${i}`, 0);
  assert.equal(cd.size, 100);
  cd.take("new", 1000); // over max -> sweep the expired ones
  assert.equal(cd.size, 1);
});

// ---------------------------------------------------------------- listener rules

const fakeMember = (roleIds) => ({ roles: { cache: new Collection(roleIds.map((id) => [id, { id }])) } });
const fakeChannel = (id, parentId) => ({ id, parentId, isThread: () => Boolean(parentId) });

test("exclusive: no rows = everyone; channels and roles each restrict", () => {
  const base = { exclusiveRoles: new Set(), exclusiveChannels: new Set() };
  assert.ok(exclusiveAllows(base, fakeChannel("c1"), null));

  const chan = { ...base, exclusiveChannels: new Set(["c1"]) };
  assert.ok(exclusiveAllows(chan, fakeChannel("c1"), null));
  assert.ok(exclusiveAllows(chan, fakeChannel("t1", "c1"), null)); // thread of c1
  assert.ok(!exclusiveAllows(chan, fakeChannel("c2"), null));

  const role = { ...base, exclusiveRoles: new Set(["r1", "r2"]) };
  assert.ok(exclusiveAllows(role, fakeChannel("c9"), fakeMember(["r2"])));
  assert.ok(!exclusiveAllows(role, fakeChannel("c9"), fakeMember(["r3"])));
  assert.ok(!exclusiveAllows(role, fakeChannel("c9"), null));

  const both = { exclusiveRoles: new Set(["r1"]), exclusiveChannels: new Set(["c1"]) };
  assert.ok(exclusiveAllows(both, fakeChannel("c1"), fakeMember(["r1"])));
  assert.ok(!exclusiveAllows(both, fakeChannel("c2"), fakeMember(["r1"])));
  assert.ok(!exclusiveAllows(both, fakeChannel("c1"), fakeMember([])));
});

test("no-self-react rules", () => {
  const cfg = { enabled: true, bypassStaff: false, punishment: "warn", emojis: new Set(), exempt: new Set() };
  const ev = { reactorId: "u1", authorId: "u1", emojiKey: "👍", channelIds: ["c1"], roleIds: ["r1"], isStaff: false };
  assert.ok(isPunishableSelfReact(cfg, ev));
  assert.ok(!isPunishableSelfReact({ ...cfg, enabled: false }, ev));
  assert.ok(!isPunishableSelfReact(cfg, { ...ev, authorId: "u2" })); // not their own message
  assert.ok(!isPunishableSelfReact({ ...cfg, emojis: new Set(["⭐"]) }, ev)); // not a monitored emoji
  assert.ok(isPunishableSelfReact({ ...cfg, emojis: new Set(["👍"]) }, ev));
  for (const id of ["u1", "c1", "r1"]) assert.ok(!isPunishableSelfReact({ ...cfg, exempt: new Set([id]) }, ev), id);
  assert.ok(isPunishableSelfReact({ ...cfg, bypassStaff: true }, ev));
  assert.ok(!isPunishableSelfReact({ ...cfg, bypassStaff: true }, { ...ev, isStaff: true }));
});

// ---------------------------------------------------------------- db + caches

test("autoresponder rows, roles and exclusive rows compile into the cache", () => {
  store.saveAutoresponder(GUILD, { trigger: "hello", script: "Hi {user}!", reply: true, creator_id: "1" });
  store.saveAutoresponder(GUILD, { trigger: "rules*", script: "Read the rules", strict: false });
  store.setTriggerRole(GUILD, "hello", "role1", "add", true);
  store.setExclusive(GUILD, "hello", "chan1", "channel", true);

  const { matcher: compiled, count } = store.caches.autoresponders.get(GUILD);
  assert.equal(count, 2);
  const [hit] = compiled.match("well hello");
  assert.equal(hit.trigger, "hello");
  assert.equal(hit.reply, 1);
  assert.deepEqual(hit.addRoles, ["role1"]);
  assert.ok(hit.exclusiveChannels.has("chan1"));
  assert.equal(compiled.match("rules please")[0].trigger, "rules*");

  // Updating keeps the creator and invalidates the cache.
  store.saveAutoresponder(GUILD, { ...store.getAutoresponder(GUILD, "hello"), strict: true });
  assert.equal(store.getAutoresponder(GUILD, "hello").creator_id, "1");
  assert.deepEqual(store.caches.autoresponders.get(GUILD).matcher.match("well hello"), []);
  assert.equal(store.caches.autoresponders.get(GUILD).matcher.match("HELLO")[0].trigger, "hello");

  assert.ok(store.removeAutoresponder(GUILD, "hello"));
  assert.deepEqual(store.listTriggerRoles(GUILD, "hello", "add"), []);
  assert.deepEqual(store.listExclusive(GUILD, "hello"), []);
  assert.equal(store.resetAutoresponders(GUILD), 1);
  assert.equal(store.caches.autoresponders.get(GUILD).count, 0);
});

test("reaction triggers group emojis per trigger and kind", () => {
  const e = (text) => ({ key: text, text, identifier: text });
  assert.ok(store.addReaction(GUILD, "normal", "w", e("🇼"), "1"));
  assert.ok(store.addReaction(GUILD, "normal", "w", e("🔥"), "1"));
  assert.ok(!store.addReaction(GUILD, "normal", "w", e("🔥"), "1")); // duplicate
  assert.ok(store.addReaction(GUILD, "previous", "w", e("👆"), "1"));

  const { normal, previous } = store.caches.reactions.get(GUILD);
  assert.deepEqual(normal.match("big W")[0].emojis, ["🇼", "🔥"]);
  assert.deepEqual(previous.match("w")[0].emojis, ["👆"]);
  assert.deepEqual(store.reactionTriggers(GUILD, "normal"), ["w"]);

  assert.equal(store.removeReactions(GUILD, "normal", "w", "🔥"), 1);
  assert.deepEqual(store.caches.reactions.get(GUILD).normal.match("w")[0].emojis, ["🇼"]);
  assert.equal(store.removeReactions(GUILD, "normal"), 1);
  assert.equal(store.countReactions(GUILD, "previous"), 1);
});

test("channel reactions and no-self-react settings", () => {
  store.setChannelReactions(GUILD, "chan1", [{ text: "👍", identifier: "👍" }, { text: "<:a:123456789012345678>", identifier: "a:123456789012345678" }]);
  assert.deepEqual(store.caches.channelReactions.get(GUILD).get("chan1"), ["👍", "a:123456789012345678"]);
  store.forgetChannel(GUILD, "chan1");
  assert.equal(store.caches.channelReactions.get(GUILD).size, 0);

  assert.equal(store.caches.noSelfReact.get(GUILD).enabled, false);
  store.setNoSelfReact(GUILD, { enabled: true });
  store.setNoSelfReact(GUILD, { punishment: "timeout" });
  const cfg = store.caches.noSelfReact.get(GUILD);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.punishment, "timeout");
  assert.ok(store.toggleNoSelfReactEmoji(GUILD, "👍", "👍"));
  assert.ok(store.toggleNoSelfReactExempt(GUILD, "role9", "role"));
  assert.ok(store.caches.noSelfReact.get(GUILD).emojis.has("👍"));
  assert.ok(!store.toggleNoSelfReactEmoji(GUILD, "👍", "👍"));
  store.forgetRole(GUILD, "role9");
  assert.equal(store.caches.noSelfReact.get(GUILD).exempt.size, 0);
});

test("command trees are valid and every subcommand has a handler", () => {
  const feature = require("./index");
  const counts = {};
  for (const command of feature.commands) {
    assert.deepEqual(command.validate(), [], command.data.name);
    counts[command.data.name] = Object.keys(command.handlers).length;
  }
  assert.deepEqual(counts, { autoresponder: 13, reaction: 23 });
});

test("wildcard triggers match in linear time (no regex backtracking)", () => {
  // As a regex (^.*a.*a.*a.*a.*b$) this took far longer than any test timeout.
  const compiled = matcher.compile([{ trigger: matcher.cleanTrigger("*a*a*a*a*b") }, { trigger: "hello" }]);
  const started = Date.now();
  assert.equal(compiled.match("a".repeat(4000)).length, 0);
  assert.ok(Date.now() - started < 500);
  assert.equal(compiled.match("xa a a ab").length, 1);
  assert.equal(compiled.match("say hello").length, 1);
});
