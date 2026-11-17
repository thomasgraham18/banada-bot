/**
 * Offline tests for /giveaways: winner selection, entry requirements,
 * reference parsing, the message layout and the database layer.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-giveaways-test-"));
const logic = require("./logic");
const store = require("./db");
const command = require("./commands/giveaways");

const DAY = logic.DAY_MS;
const NOW = Date.UTC(2026, 10, 17);

function fakeMember({ roles = [], createdDaysAgo = 365, joinedDaysAgo = 30 } = {}) {
  return {
    roles: { cache: new Set(roles) },
    user: { createdTimestamp: NOW - createdDaysAgo * DAY },
    joinedTimestamp: joinedDaysAgo == null ? null : NOW - joinedDaysAgo * DAY,
  };
}
const ids = (n) => Array.from({ length: n }, (_, i) => `u${i}`);

// ---------------------------------------------------------------- pickWinners

test("pickWinners returns unique winners from the entrants", async () => {
  for (let run = 0; run < 200; run++) {
    const winners = await logic.pickWinners(ids(20), 5);
    assert.equal(winners.length, 5);
    assert.equal(new Set(winners).size, 5);
    for (const w of winners) assert.ok(ids(20).includes(w));
  }
});

test("pickWinners ignores duplicate entries", async () => {
  const winners = await logic.pickWinners(["a", "a", "a", "b"], 5);
  assert.deepEqual(winners.sort(), ["a", "b"]);
});

test("fewer entrants than winners: everyone wins, nobody twice", async () => {
  const winners = await logic.pickWinners(ids(3), 10);
  assert.deepEqual([...winners].sort(), ids(3));
  assert.deepEqual(await logic.pickWinners([], 3), []);
});

test("pickWinners skips excluded users (previous winners on reroll)", async () => {
  for (let run = 0; run < 50; run++) {
    const winners = await logic.pickWinners(ids(5), 5, { exclude: ["u0", "u1"] });
    assert.deepEqual([...winners].sort(), ["u2", "u3", "u4"]);
  }
});

test("pickWinners skips ineligible candidates (left server / lost a required role)", async () => {
  const eligible = new Set(["u1", "u3"]);
  let checks = 0;
  const winners = await logic.pickWinners(ids(10), 5, {
    isEligible: async (id) => (checks++, eligible.has(id)),
  });
  assert.deepEqual([...winners].sort(), ["u1", "u3"]);
  assert.equal(checks, 10, "every entrant is checked at most once");
});

test("pickWinners draws with the injected randomInt (crypto by default) and is not biased", async () => {
  // Deterministic: always taking index 0 picks u0, then the swapped-in last element.
  assert.deepEqual(await logic.pickWinners(["a", "b", "c", "d"], 2, { randomInt: () => 0 }), ["a", "d"]);
  // Rough uniformity: each of 4 entrants should win a single-winner draw ~25% of the time.
  const counts = { a: 0, b: 0, c: 0, d: 0 };
  for (let i = 0; i < 4000; i++) counts[(await logic.pickWinners(["a", "b", "c", "d"], 1))[0]]++;
  for (const n of Object.values(counts)) assert.ok(n > 800 && n < 1200, `count ${n} out of range`);
});

test("winner selection never uses Math.random", () => {
  const source = fs.readFileSync(path.join(__dirname, "logic.js"), "utf8") + fs.readFileSync(path.join(__dirname, "service.js"), "utf8");
  assert.ok(!/Math\.random/.test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
});

// ---------------------------------------------------------------- requirements

test("no requirements: anyone can enter", () => {
  assert.deepEqual(logic.checkRequirements({}, fakeMember(), { now: NOW }), []);
});

test("required roles: the member needs all of them", () => {
  const gw = { required_roles: ["r1", "r2"] };
  assert.deepEqual(logic.checkRequirements(gw, fakeMember({ roles: ["r1", "r2", "r3"] }), { now: NOW }), []);
  const reasons = logic.checkRequirements(gw, fakeMember({ roles: ["r1"] }), { now: NOW });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /<@&r2>/);
  assert.doesNotMatch(reasons[0], /<@&r1>/);
});

test("min / max level", () => {
  const gw = { min_level: 5, max_level: 10 };
  assert.deepEqual(logic.checkRequirements(gw, fakeMember(), { level: 7, now: NOW }), []);
  assert.deepEqual(logic.checkRequirements(gw, fakeMember(), { level: 5, now: NOW }), []);
  assert.deepEqual(logic.checkRequirements(gw, fakeMember(), { level: 10, now: NOW }), []);
  assert.match(logic.checkRequirements(gw, fakeMember(), { level: 4, now: NOW })[0], /at least level \*\*5\*\*/);
  assert.match(logic.checkRequirements(gw, fakeMember(), { level: 11, now: NOW })[0], /level \*\*10\*\* or lower/);
  // Levels package missing -> a clear refusal, not a crash.
  assert.match(logic.checkRequirements(gw, fakeMember(), { level: null, now: NOW })[0], /levels system isn't available/);
  // 0 means "no requirement".
  assert.deepEqual(logic.checkRequirements({ min_level: 0, max_level: 0 }, fakeMember(), { now: NOW }), []);
});

test("account age and server stay", () => {
  const gw = { min_age_days: 7, min_stay_days: 3 };
  assert.deepEqual(logic.checkRequirements(gw, fakeMember({ createdDaysAgo: 7, joinedDaysAgo: 3 }), { now: NOW }), []);
  assert.equal(logic.checkRequirements(gw, fakeMember({ createdDaysAgo: 6, joinedDaysAgo: 3 }), { now: NOW }).length, 1);
  assert.equal(logic.checkRequirements(gw, fakeMember({ createdDaysAgo: 7, joinedDaysAgo: 2 }), { now: NOW }).length, 1);
  assert.equal(logic.checkRequirements(gw, fakeMember({ createdDaysAgo: 1, joinedDaysAgo: null }), { now: NOW }).length, 2);
});

test("every failed requirement is reported", () => {
  const gw = { required_roles: ["r1"], min_level: 3, min_age_days: 30, min_stay_days: 30 };
  assert.equal(logic.checkRequirements(gw, fakeMember({ createdDaysAgo: 1, joinedDaysAgo: 1 }), { level: 1, now: NOW }).length, 4);
});

// ---------------------------------------------------------------- references + layout

test("parseReference accepts message links, message IDs and #ids", () => {
  assert.deepEqual(logic.parseReference("https://discord.com/channels/1/2/123456789012345678"), { messageId: "123456789012345678" });
  assert.deepEqual(logic.parseReference("123456789012345678"), { messageId: "123456789012345678" });
  assert.deepEqual(logic.parseReference("#12"), { id: 12 });
  assert.deepEqual(logic.parseReference("12"), { id: 12 });
  assert.equal(logic.parseReference("nope"), null);
});

test("buildMessage renders running and ended giveaways", () => {
  const base = { id: 3, prize: "Nitro", winners: 2, ends_at: NOW + DAY, hosts: ["h1"], required_roles: ["r1"], min_level: 5, entry_count: 4 };
  const running = logic.buildMessage(base);
  const embed = running.embeds[0].toJSON();
  assert.equal(embed.title, "Nitro");
  assert.match(embed.description, /Winners:\*\* 2/);
  assert.match(embed.description, /Level: 5\+/);
  const button = running.components[0].toJSON().components[0];
  assert.equal(button.custom_id, "gw:enter:3");
  assert.equal(button.label, "Enter (4)");
  assert.ok(!button.disabled);

  const ended = logic.buildMessage({ ...base, ended: true, ended_at: NOW, winner_ids: ["w1", "w2"] });
  assert.match(ended.embeds[0].toJSON().description, /<@w1>, <@w2>/);
  assert.ok(ended.components[0].toJSON().components[0].disabled);
  const hidden = logic.buildMessage({ ...base, ended: true, ended_at: NOW, hide_winners: true, winner_ids: ["w1"] });
  assert.doesNotMatch(hidden.embeds[0].toJSON().description, /<@w1>/);
});

// ---------------------------------------------------------------- database

test("store: create, entries, winners, lists, cascade delete", () => {
  const id = store.create({ guildId: "g1", channelId: "c1", prize: "Prize", winners: 2, color: null, endsAt: NOW, createdBy: "host" });
  store.setMessage(id, "900000000000000001");
  assert.equal(store.addEntry(id, "a"), true);
  assert.equal(store.addEntry(id, "a"), false, "entering twice is a no-op");
  store.addEntry(id, "b");
  assert.equal(store.countEntries(id), 2);
  assert.equal(store.removeEntry(id, "b"), true);
  assert.deepEqual(store.listEntries(id), ["a"]);

  store.replaceList("required", id, ["r1", "r2", "r1"]);
  store.update(id, "min_level", 4);
  let gw = store.getByMessage("g1", "900000000000000001");
  assert.deepEqual(gw.hosts, ["host"]);
  assert.deepEqual(gw.required_roles.sort(), ["r1", "r2"]);
  assert.equal(gw.min_level, 4);
  assert.throws(() => store.update(id, "guild_id", "x"));

  assert.equal(store.markEnded(id), true);
  assert.equal(store.markEnded(id), false, "only the first end counts");
  store.addWinners(id, ["a"]);
  store.addWinners(id, ["a"], { rerolled: true }); // already a winner: ignored
  gw = store.get(id);
  assert.equal(gw.ended, true);
  assert.deepEqual(gw.winner_ids, ["a"]);
  assert.equal(store.latestEndedInChannel("g1", "c1"), id);
  assert.equal(store.listForGuild("g1", { ended: true }).length, 1);
  assert.equal(store.listForGuild("g1", { ended: false }).length, 0);

  store.remove(id);
  assert.equal(store.get(id), undefined);
  assert.equal(store.countEntries(id), 0);
});

test("/giveaways tree is valid and has 20 subcommands", () => {
  assert.deepEqual(command.validate(), []);
  assert.equal(Object.keys(command.handlers).length, 20);
});
