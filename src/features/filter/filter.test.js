/**
 * Offline tests for the filter package: matching, points ladder, settings
 * resolution, AutoMod rule building and the DB layer. No Discord connection.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-filter-test-"));
const m = require("./match");
const p = require("./points");
const store = require("./db");
const { desiredRule } = require("./automod");
const filter = require("./index");

const words = (block = [], allow = [], regex = []) =>
  m.compileWords([
    ...block.map((word) => ({ word, kind: "block" })),
    ...allow.map((word) => ({ word, kind: "allow" })),
    ...regex.map((word) => ({ word, kind: "regex" })),
  ]);

test("plain words match whole words only, case/accent/zero-width insensitive", () => {
  const w = words(["bad"]);
  assert.ok(m.matchWords(w, "this is BAD"));
  assert.ok(m.matchWords(w, "b​àd!"));
  assert.ok(m.matchWords(w, "Ｂａｄ")); // fullwidth
  assert.equal(m.matchWords(w, "badge"), null);
  assert.equal(m.matchWords(w, "notbad"), null);
});

test("wildcards behave like AutoMod and the allow list is per word", () => {
  assert.ok(m.matchWords(words(["bad*"]), "badge"));
  assert.equal(m.matchWords(words(["bad*"]), "notbad"), null);
  assert.ok(m.matchWords(words(["*bad"]), "notbad"));
  assert.ok(m.matchWords(words(["*bad*"]), "forbade"));
  const w = words(["*ass*"], ["class"]);
  assert.equal(m.matchWords(w, "first class seats"), null);
  assert.equal(m.matchWords(w, "grass").match, "grass");
  assert.ok(m.matchWords(words(["very bad"]), "so very   bad"));
});

test("regex patterns match and dangerous patterns are rejected", () => {
  const w = words([], [], ["fr[e3]{2}\\s*nitro"]);
  assert.equal(m.matchWords(w, "get FRE3 nitro here").rule, "regex");
  assert.equal(m.matchWords(w, "nitro"), null);
  // Catastrophic-backtracking patterns are safe now: they run on V8's linear engine.
  assert.equal(m.regexProblem("(a+)+$"), null);
  assert.equal(m.regexProblem("(a|a)*b"), null);
  const evil = m.compileWords([{ word: "(a|a)*b", kind: "regex" }]);
  const started = Date.now();
  assert.equal(m.matchWords(evil, "a".repeat(50000) + "c"), null);
  assert.ok(Date.now() - started < 500, "regex matching must stay linear");
  assert.match(m.regexProblem("(?=a)b"), /Lookarounds/);
  assert.equal(m.matchWords(m.compileWords([{ word: "CAT", kind: "regex" }]), "a Cat!")?.match, "cat", "case-insensitive");
  assert.match(m.regexProblem("(unclosed"), /valid regex/);
  assert.equal(m.regexProblem("\\bcat\\b"), null);
});

test("caps percentage ignores short messages, mentions and urls", () => {
  assert.equal(m.capsPercent("OK LOL"), 0);
  assert.equal(m.capsPercent("THIS IS VERY LOUD"), 100);
  assert.equal(m.capsPercent("This is a normal sentence"), 5);
  assert.equal(m.capsPercent("hello there friend https://EXAMPLE.COM/ABCDEFGHIJ"), 0);
});

test("emoji, mention, newline, zalgo and massmention counters", () => {
  assert.equal(m.countEmojis("hi 😀😀 <:pog:123456789012345678> 👨‍👩‍👧 🇬🇧"), 5);
  assert.equal(m.countEmojis("no emoji 123 #"), 0);
  assert.equal(m.countMentions("<@111111111111111111> <@!111111111111111111> <@&222222222222222222>"), 2);
  assert.equal(m.countNewlines("a\nb\nc"), 2);
  assert.ok(m.maxCombiningRun("z̀́̂̃algo") >= 4);
  assert.equal(m.maxCombiningRun("café"), 0);
  assert.ok(m.hasMassMention("hey @everyone"));
  assert.ok(!m.hasMassMention("email@everyones.com"));
});

test("invites and links with a subdomain-aware whitelist", () => {
  assert.ok(m.findInvite("join discord.gg/abc123"));
  assert.ok(m.findInvite("https://discord.com/invite/xyz"));
  assert.equal(m.findInvite("discord.com/channels/1/2"), null);
  const allowed = new Set(["youtube.com"]);
  assert.equal(m.findBadLink("https://www.youtube.com/watch?v=1 https://m.youtube.com/x", allowed), null);
  assert.equal(m.findBadLink("see https://evil.com/youtube.com", allowed), "evil.com");
  assert.equal(m.findBadLink("https://notyoutube.com", allowed), "notyoutube.com");
  assert.equal(m.parseHost("https://WWW.Example.com/path"), "example.com");
  assert.equal(m.parseHost("not a site"), null);
});

test("spam sliding window trips at the threshold and resets", () => {
  const spam = new m.SpamTracker(5000);
  const t = 1_000_000;
  assert.equal(spam.hit("u", {}, 3, t), null);
  assert.equal(spam.hit("u", {}, 3, t + 1000), null);
  assert.equal(spam.hit("u", {}, 3, t + 2000).length, 3);
  assert.equal(spam.hit("u", {}, 3, t + 2100), null); // new window
  // Old messages slide out of the window.
  const s2 = new m.SpamTracker(5000);
  s2.hit("u", {}, 3, t);
  s2.hit("u", {}, 3, t + 1000);
  assert.equal(s2.hit("u", {}, 3, t + 6000), null);
  s2.sweep(t + 20_000);
  assert.equal(s2.windows.size, 0);
});

test("per-channel override beats the server default only in that channel", () => {
  const compiled = m.compileGuild({
    settings: [
      { type: "caps", channel_id: "", enabled: 1, threshold: 70, punishment: "delete" },
      { type: "caps", channel_id: "C2", enabled: 1, threshold: 90, punishment: null },
      { type: "links", channel_id: "C3", enabled: 0 },
      { type: "links", channel_id: "", enabled: 1 },
    ],
  });
  assert.ok(compiled.active);
  assert.equal(m.settingFor(compiled, "caps", ["C1"]).threshold, 70);
  assert.equal(m.settingFor(compiled, "caps", ["C2"]).threshold, 90);
  assert.equal(m.settingFor(compiled, "caps", ["C2"]).punishment, "delete"); // inherited
  assert.equal(m.settingFor(compiled, "caps", ["thread", "C2"]).threshold, 90); // thread -> parent
  assert.equal(m.settingFor(compiled, "links", ["C3"]), null);
  assert.equal(m.settingFor(compiled, "spam", ["C1"]), null);
  const input = { content: "THIS IS MOSTLY CAPS ok" };
  assert.ok(m.detect("caps", input, 70, compiled));
  assert.equal(m.detect("caps", input, 90, compiled), null);
});

test("points: decay, limit and ladder steps", () => {
  const day = 86400e3;
  assert.equal(p.decayed(5, 0, 2.5 * day), 3);
  assert.equal(p.decayed(1, 0, 10 * day), 0);
  assert.equal(p.addPoints(9, 3, 10), 10);
  const ladder = p.parseLadder("3 timeout 10m\n6: jail\n10 = ban");
  assert.deepEqual(ladder.map((s) => [s.points, s.punishment, s.durationMs]), [[3, "timeout", 600e3], [6, "jail", null], [10, "ban", null]]);
  // Three link violations at 1 point each -> timeout on the third.
  let total = 0;
  const fired = [];
  for (let i = 0; i < 3; i++) {
    const after = p.addPoints(total, 1, null);
    fired.push(p.ladderStep(ladder, total, after)?.punishment ?? null);
    total = after;
  }
  assert.deepEqual(fired, [null, null, "timeout"]);
  assert.equal(p.ladderStep(ladder, 2, 7).punishment, "jail"); // jumped two steps: highest fires
  assert.equal(p.ladderStep(ladder, 6, 6, 6).punishment, "jail"); // at the cap: re-applied
  assert.throws(() => p.parseLadder("3 explode"), /ladder punishment/);
  assert.throws(() => p.parseLadder("3 kick 10m"), /duration/);
  assert.deepEqual([...p.parsePointValues("words=3, spam 2")], [["words", 3], ["spam", 2]]);
  assert.equal(p.parseLadder(p.formatLadder(ladder)).length, 3);
});

test("names: zalgo stripped, blocked words replaced", () => {
  const compiled = m.compileGuild({ words: [{ word: "bad", kind: "block" }] });
  assert.deepEqual(m.cleanName("Nè́̂̃o", compiled, 3, "Moderated"), { name: "Neo", reason: "zalgo" });
  assert.equal(m.cleanName("bad guy", compiled, 3, "Moderated").name, "Moderated");
  assert.equal(m.cleanName("Alice", compiled, 3, "Moderated"), null);
});

test("AutoMod rule is built only for block/timeout punishments", () => {
  const base = { words: [{ word: "bad", kind: "block" }, { word: "class", kind: "allow" }], exempt: [{ type: "words", role_id: "R1" }] };
  const on = m.compileGuild({ ...base, settings: [{ type: "words", channel_id: "", enabled: 1, punishment: "timeout", duration_ms: 3600e3 }, { type: "words", channel_id: "C9", enabled: 0 }] });
  const rule = desiredRule(on, "words", ["STAFF"]);
  assert.deepEqual(rule.triggerMetadata.keywordFilter, ["bad"]);
  assert.deepEqual(rule.triggerMetadata.allowList, ["class"]);
  assert.deepEqual(rule.exemptRoles, ["R1", "STAFF"]);
  assert.deepEqual(rule.exemptChannels, ["C9"]);
  assert.equal(rule.actions[1].metadata.durationSeconds, 3600);
  const pts = m.compileGuild({ ...base, settings: [{ type: "words", channel_id: "", enabled: 1, punishment: "points" }] });
  assert.equal(desiredRule(pts, "words"), null);
  const mention = m.compileGuild({ settings: [{ type: "mentions", channel_id: "", enabled: 1, threshold: 8 }] });
  assert.equal(desiredRule(mention, "mentions").triggerMetadata.mentionTotalLimit, 8);
});

test("db writes invalidate the cache and copyChannel duplicates overrides", () => {
  const g = "900000000000000001";
  assert.equal(store.rules.get(g).active, false);
  store.setSetting(g, "caps", "", { enabled: true, threshold: 60 });
  store.setSetting(g, "caps", "A", { enabled: true, threshold: 95, punishment: "points" });
  store.setSetting(g, "caps", "A", { enabled: false }); // partial update keeps threshold
  assert.equal(store.rules.get(g).active, true);
  assert.equal(m.describeSetting(store.rules.get(g), "caps", "A").threshold, 95);
  assert.equal(filter.api.copyChannel(g, "A", "B"), 1);
  const copied = m.describeSetting(store.rules.get(g), "caps", "B");
  assert.equal(copied.threshold, 95);
  assert.equal(copied.enabled, false);
  store.clearOverrides(g, "caps");
  assert.equal(store.rules.get(g).types.get("caps").channels.size, 0);
  store.addWord(g, "block", "bad", "1");
  assert.ok(m.matchWords(store.rules.get(g).words, "so bad"));
  store.savePoints(g, "U", 4);
  assert.equal(store.getPointsRow(g, "U").points, 4);
});
