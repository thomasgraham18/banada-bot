/**
 * Offline tests for the levels package (no Discord connection).
 *   npm test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

// A throwaway database: must be set before core is required.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-levels-test-"));
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require("discord.js");
const formula = require("./formula");
const store = require("./db");
const levels = require("./index");
const { onMessage, cooldowns } = require("./listeners");

const G = "200000000000000001";

// ---------------------------------------------------------------- formula

test("xpForLevel follows 5n² + 50n + 100", () => {
  assert.equal(formula.xpForLevel(0), 100);
  assert.equal(formula.xpForLevel(1), 155);
  assert.equal(formula.xpForLevel(10), 1100);
});

test("totalXpForLevel matches summing the curve", () => {
  let sum = 0;
  for (let level = 0; level <= 300; level++) {
    assert.equal(formula.totalXpForLevel(level), sum, `level ${level}`);
    sum += formula.xpForLevel(level);
  }
});

test("levelForXp / totalXpForLevel round-trip at every boundary", () => {
  for (let level = 0; level <= formula.MAX_LEVEL; level++) {
    const total = formula.totalXpForLevel(level);
    assert.equal(formula.levelForXp(total), level);
    if (level > 0) assert.equal(formula.levelForXp(total - 1), level - 1);
  }
  assert.equal(formula.levelForXp(0), 0);
  assert.equal(formula.levelForXp(-5), 0);
  assert.equal(formula.levelForXp(Number.MAX_SAFE_INTEGER), formula.MAX_LEVEL);
});

test("progress: setlevel 10 means 0 XP into level 10", () => {
  const p = formula.progress(formula.totalXpForLevel(10));
  assert.deepEqual(
    { level: p.level, current: p.current, needed: p.needed, nextLevel: p.nextLevel },
    { level: 10, current: 0, needed: 1100, nextLevel: 11 }
  );
  assert.equal(p.nextXp, formula.totalXpForLevel(11));
  assert.equal(formula.progress(formula.MAX_XP).needed, 0);
});

test("rollXp: 15–25 base, multiplied, clamped multiplier, at least 1", () => {
  assert.equal(formula.rollXp(1, () => 0), 15);
  assert.equal(formula.rollXp(1, () => 0.9999), 25);
  assert.equal(formula.rollXp(2, () => 0), 30);
  assert.equal(formula.rollXp(0.25, () => 0), 4);
  assert.equal(formula.rollXp(10, () => 0.9999), 75); // clamped to 3×
  assert.equal(formula.rollXp(0.01, () => 0), 4); // clamped to 0.25×
  for (let i = 0; i < 500; i++) {
    const xp = formula.rollXp(1.5);
    assert.ok(xp >= 23 && xp <= 38, `got ${xp}`);
  }
});

test("planLevelRoles: stack keeps every earned role", () => {
  const roles = [{ level: 5, roleId: "a" }, { level: 10, roleId: "b" }, { level: 20, roleId: "c" }];
  assert.deepEqual(formula.planLevelRoles(roles, 12, true, new Set(["a"])), { keep: ["a", "b"], add: ["b"], remove: [] });
  assert.deepEqual(formula.planLevelRoles(roles, 4, true, new Set(["a", "x"])), { keep: [], add: [], remove: ["a"] });
});

test("planLevelRoles: replace keeps only the highest earned role", () => {
  const roles = [{ level: 10, roleId: "a" }, { level: 20, roleId: "b" }, { level: 30, roleId: "c" }];
  // Acceptance: reaching 20 with stacking off removes the level-10 role, adds the level-20 one.
  assert.deepEqual(formula.planLevelRoles(roles, 20, false, new Set(["a", "other"])), { keep: ["b"], add: ["b"], remove: ["a"] });
  assert.deepEqual(formula.planLevelRoles(roles, 25, false, new Set(["b"])), { keep: ["b"], add: [], remove: [] });
  assert.deepEqual(formula.planLevelRoles(roles, 1, false, new Set()), { keep: [], add: [], remove: [] });
});

test("progressBar", () => {
  assert.equal(formula.progressBar(0, 100, 4), "▱▱▱▱");
  assert.equal(formula.progressBar(50, 100, 4), "▰▰▱▱");
  assert.equal(formula.progressBar(5, 0, 4), "▰▰▰▰");
});

// ---------------------------------------------------------------- storage + api

test("api: getLevel / getXp / getLeaderboard", () => {
  assert.equal(levels.api.getLevel(G, "nobody"), 0);
  assert.equal(levels.api.getXp(G, "nobody"), 0);
  store.setXp(G, "u1", formula.totalXpForLevel(10));
  store.setXp(G, "u2", 50);
  store.setXp(G, "u3", formula.totalXpForLevel(3) + 7);
  store.setXp(G, "u4", 0); // no XP: not on the leaderboard
  assert.equal(levels.api.getLevel(G, "u1"), 10);
  assert.equal(levels.api.getXp(G, "u3"), formula.totalXpForLevel(3) + 7);
  assert.deepEqual(levels.api.getLeaderboard(G).map((r) => r.userId), ["u1", "u3", "u2"]);
  assert.deepEqual(levels.api.getLeaderboard(G, { limit: 1, offset: 1 }), [{ userId: "u3", xp: formula.totalXpForLevel(3) + 7, level: 3 }]);
  assert.equal(store.rankOf(G, 50), 3);
  assert.equal(store.rankedCount(G), 3);
});

test("awardXp is one upsert that returns the new total and the old level", () => {
  const first = store.awardXp(G, "fresh", 20);
  assert.deepEqual({ ...first }, { xp: 20, level: 0, messages_opt_out: 0 });
  const second = store.awardXp(G, "fresh", 90);
  assert.equal(second.xp, 110);
  assert.equal(second.level, 0); // stored level only changes through storeLevel()
});

test("settings cache invalidates on write; multiplier is clamped", () => {
  assert.equal(store.settings.get(G).enabled, false);
  store.updateConfig(G, { enabled: true, multiplier: 9 });
  assert.equal(store.settings.get(G).enabled, true);
  assert.equal(store.settings.get(G).multiplier, 3);
  assert.equal(store.toggleIgnore(G, "c1", "channel"), true);
  assert.ok(store.settings.get(G).ignoredChannels.has("c1"));
  assert.equal(store.toggleIgnore(G, "c1", "channel"), false);
  assert.ok(!store.settings.get(G).ignoredChannels.has("c1"));
  store.updateConfig(G, { multiplier: 1 });
});

test("resetGuild keeps opt-outs, deleteMembers removes rows", () => {
  const g = "200000000000000009";
  store.setXp(g, "a", 500);
  store.setXp(g, "b", 500);
  store.setOptOut(g, "b", true);
  assert.equal(store.resetGuild(g), 2);
  assert.equal(store.getXp(g, "a"), 0);
  assert.equal(store.getMember(g, "a"), undefined);
  assert.equal(store.getMember(g, "b").messages_opt_out, 1);
  assert.equal(store.deleteMembers(g, ["b", "zzz"]), 1);
});

// ---------------------------------------------------------------- listener

function fakeWorld(guildId, memberRoleIds) {
  const guildRoles = new Collection();
  const role = (id, position) => ({ id, position, managed: false, comparePositionTo: (o) => position - o.position });
  const guild = { id: guildId, roles: { cache: guildRoles }, channels: { cache: new Collection() } };
  for (const [i, id] of ["r1", "r2"].entries()) guildRoles.set(id, role(id, i + 1));
  guild.members = { cache: new Collection(), me: { permissions: new PermissionsBitField([P.ManageRoles]), roles: { highest: role("bot", 10) } } };

  const held = new Collection(memberRoleIds.map((id) => [id, guildRoles.get(id)]));
  const calls = { add: [], remove: [], sent: [] };
  const member = {
    id: "m1", guild, user: { id: "m1", username: "m", bot: false, displayAvatarURL: () => "" }, displayName: "M",
    roles: {
      cache: held,
      add: async (ids) => { calls.add.push(...ids); ids.forEach((id) => held.set(id, guildRoles.get(id))); },
      remove: async (ids) => { calls.remove.push(...ids); ids.forEach((id) => held.delete(id)); },
    },
  };
  const channel = { id: "chan", name: "chat", parentId: null, isTextBased: () => true, send: async (p) => calls.sent.push(p) };
  const message = { inGuild: () => true, author: member.user, system: false, webhookId: null, guildId, channel, member };
  return { message, member, calls };
}

test("messageCreate: cooldown, ignores, level-up replaces roles and announces", async () => {
  const g = "200000000000000002";
  store.updateConfig(g, { enabled: true, stack_roles: false });
  store.setLevelRole(g, 1, "r1");
  store.setLevelRole(g, 2, "r2");
  store.setXp(g, "m1", formula.totalXpForLevel(2) - 1); // 1 XP short of level 2
  const { message, calls } = fakeWorld(g, ["r1"]);

  // Ignored channel: no XP.
  store.toggleIgnore(g, "chan", "channel");
  await onMessage(null, message);
  assert.equal(store.getXp(g, "m1"), formula.totalXpForLevel(2) - 1);
  store.toggleIgnore(g, "chan", "channel");

  await onMessage(null, message);
  assert.equal(store.getLevel(g, "m1"), 2);
  assert.deepEqual(calls.add, ["r2"]);
  assert.deepEqual(calls.remove, ["r1"]);
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].content, /level 2/);

  // Within the cooldown: nothing changes.
  const xp = store.getXp(g, "m1");
  await onMessage(null, message);
  assert.equal(store.getXp(g, "m1"), xp);

  // After the cooldown, with messages opted out: XP but no message.
  cooldowns.clear();
  store.setOptOut(g, "m1", true);
  store.setXp(g, "m1", formula.totalXpForLevel(3) - 1);
  await onMessage(null, message);
  assert.equal(store.getLevel(g, "m1"), 3);
  assert.equal(calls.sent.length, 1);
});

test("messageCreate: locked guilds and no-XP roles earn nothing", async () => {
  const g = "200000000000000003";
  const { message } = fakeWorld(g, ["r1"]);
  await onMessage(null, message);
  assert.equal(store.getXp(g, "m1"), 0); // locked by default
  store.updateConfig(g, { enabled: true });
  store.toggleIgnore(g, "r1", "role");
  cooldowns.clear();
  await onMessage(null, message);
  assert.equal(store.getXp(g, "m1"), 0);
});

// ---------------------------------------------------------------- command tree

test("/levels tree is valid and every subcommand has a handler", () => {
  const [command] = levels.commands;
  assert.deepEqual(command.validate(), []);
  assert.equal(Object.keys(command.handlers).length, 27);
  const gates = Object.fromEntries(Object.entries(command.handlers).map(([k, h]) => [k, h.gate]));
  for (const pub of ["rank", "roles", "leaderboard view", "messages"]) assert.equal(gates[pub], undefined, pub);
  assert.equal(gates.reset, "Server Owner");
  assert.equal(gates.cleanup, "Server Owner");
  assert.equal(gates.setxp, "Manage Guild");
});
