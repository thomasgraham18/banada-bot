/**
 * Offline tests for /automation's pure parts and storage.
 *   npm test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-automation-test-"));

const { UserError, script } = require("../../core");
const fmt = require("./format");
const store = require("./db");

test("counter numbers format plain, prettified and with a currency", () => {
  assert.equal(fmt.formatCount(1234), "1,234");
  assert.equal(fmt.formatCount(1234, { prettify: true }), "1.2K");
  assert.equal(fmt.formatCount(2_500_000, { prettify: true, currency: "$" }), "$2.5M");
  assert.equal(fmt.formatCount(7, { currency: "€" }), "€7");
});

test("counter templates and names", () => {
  assert.equal(fmt.counterTemplate("members"), "Members: {count}");
  assert.equal(fmt.counterTemplate("bots", "Robots"), "Robots: {count}");
  assert.equal(fmt.counterTemplate("members", "👥 {count} people"), "👥 {count} people");
  assert.equal(fmt.counterName("Members: {count}", "1,234"), "Members: 1,234");
  assert.equal(fmt.counterName("x".repeat(120) + "{count}", "5").length, 100);
});

test("timer intervals: default 1h, min 5m, max 30d", () => {
  assert.equal(fmt.timerInterval(undefined), 3_600_000);
  assert.equal(fmt.timerInterval("30m"), 1_800_000);
  assert.throws(() => fmt.timerInterval("2m"), UserError);
  assert.throws(() => fmt.timerInterval("60d"), UserError);
  assert.throws(() => fmt.timerInterval("soon"), UserError);
});

test("periods start at UTC midnight, Monday and the 1st", () => {
  const wed = Date.UTC(2026, 10, 18, 15, 30); // Wednesday 18 Nov 2026
  assert.equal(fmt.periodStart("daily", wed), Date.UTC(2026, 10, 18));
  assert.equal(fmt.periodStart("weekly", wed), Date.UTC(2026, 10, 16));
  assert.equal(fmt.periodStart("weekly", Date.UTC(2026, 10, 22, 23)), Date.UTC(2026, 10, 16), "Sunday belongs to the week before");
  assert.equal(fmt.periodStart("monthly", wed), Date.UTC(2026, 10, 1));
  assert.equal(fmt.periodStart("alltime", wed), 0);
});

test("leaderboard values read naturally", () => {
  assert.equal(fmt.formatValue("messages", { value: 1 }), "1 message");
  assert.equal(fmt.formatValue("messages", { value: 1234 }), "1,234 messages");
  assert.equal(fmt.formatValue("voice", { value: 3 * 3600 + 20 * 60 + 5 }), "3h 20m");
  assert.equal(fmt.formatValue("levels", { level: 5, xp: 1234 }), "Level 5 (1,234 XP)");
});

test("leaderboard lines repeat per entry and render through core scripts", () => {
  const rows = [{ userId: "1", value: 10 }, { userId: "2", value: 5 }, { userId: "3", value: 1 }, { userId: "4", value: 1 }];
  const stored = fmt.boardScript(null, "messages", rows, { 2: "⭐" });
  const payload = script.render(stored, { vars: fmt.boardVars("messages", "weekly", 0) });
  const embed = payload.embeds[0].data;
  assert.equal(embed.title, "Messages leaderboard · Weekly");
  const lines = embed.description.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "🥇 <@1> · **10 messages**");
  assert.equal(lines[1], "⭐ <@2> · **5 messages**");
  assert.equal(lines[3], "`#4` <@4> · **1 message**");

  // Plain text scripts: only lines with entry variables repeat.
  const text = JSON.parse(fmt.boardScript("Top chatters\n{rank}. {user} {value}\nGG", "messages", rows.slice(0, 2)));
  assert.equal(text.content, "Top chatters\n1. <@1> 10 messages\n2. <@2> 5 messages\nGG");

  // Empty boards say so once.
  assert.equal(JSON.parse(fmt.boardScript("{user}\n{value}", "voice", [])).content, fmt.EMPTY_BOARD);

  // At most 10 entries.
  const many = Array.from({ length: 15 }, (_, i) => ({ userId: String(i), value: 15 - i }));
  assert.equal(JSON.parse(fmt.boardScript("{user}", "messages", many)).content.split("\n").length, 10);
});

test("activity stats sum daily buckets per timeframe and keep all-time", () => {
  const day = 86_400_000;
  const today = fmt.dayStart();
  store.stats.add("g1", "a", "messages", 5, today);
  store.stats.add("g1", "b", "messages", 3, today);
  store.stats.add("g1", "b", "messages", 10, today - 40 * day);
  assert.deepEqual(store.stats.top("g1", "messages", today, 10), [{ userId: "a", value: 5 }, { userId: "b", value: 3 }]);
  assert.deepEqual(store.stats.top("g1", "messages", 0, 10), [{ userId: "b", value: 13 }, { userId: "a", value: 5 }]);
  assert.equal(store.stats.prune(today - 30 * day), 1);
  assert.deepEqual(store.stats.top("g1", "messages", 0, 1), [{ userId: "b", value: 13 }], "pruning keeps all-time rows");
});

test("leaderboards, emotes and publisher channels round-trip through the caches", () => {
  store.boards.upsertChannel("g2", "voice", "daily", "c1");
  assert.ok(store.trackedKinds.get("g2").has("voice"));
  store.boards.setEmotes("g2", "voice", ["🔥", "💧"]);
  assert.deepEqual(store.boards.emotes("g2", "voice"), { 1: "🔥", 2: "💧" });
  store.boards.remove("g2", "voice", "daily");
  assert.equal(store.trackedKinds.get("g2").has("voice"), false);

  assert.equal(store.publisher.add("g2", "c9"), 1);
  assert.equal(store.publisher.add("g2", "c9"), 0);
  assert.ok(store.publisher.has("g2", "c9"));
  store.publisher.remove("g2", "c9");
  assert.equal(store.publisher.has("g2", "c9"), false);
});

test("publisher rate limiter allows 10 per hour per channel", () => {
  const { canPublish } = require("./listeners");
  const now = 1_000_000_000;
  for (let i = 0; i < 10; i++) assert.ok(canPublish("ch", now + i));
  assert.equal(canPublish("ch", now + 20), false);
  assert.ok(canPublish("ch", now + 3_600_001), "an hour later it frees up");
});

test("the /automation tree has 42 subcommands and validates", () => {
  const command = require("./commands/automation");
  assert.deepEqual(command.validate(), []);
  const groups = command.data.toJSON().options;
  assert.equal(groups.length, 7);
  assert.equal(groups.reduce((n, g) => n + g.options.length, 0), 42);
});
