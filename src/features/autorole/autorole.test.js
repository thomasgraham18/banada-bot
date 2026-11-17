/**
 * Offline tests for /autorole: pure logic, the data layer and the command tree.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-autorole-test-"));
const { ButtonStyle } = require("discord.js");
const { UserError } = require("../../core");
const logic = require("./logic");
const store = require("./db");

const G = "200000000000000001";

test("insertAt / removeAt renumber positions", () => {
  let list = logic.insertAt([], { role_id: "a" });
  list = logic.insertAt(list, { role_id: "b" });
  list = logic.insertAt(list, { role_id: "c" }, 1);
  assert.deepEqual(list.map((x) => [x.idx, x.role_id]), [[1, "c"], [2, "a"], [3, "b"]]);
  assert.throws(() => logic.insertAt(list, { role_id: "d" }, 5), UserError);
  const { removed, items } = logic.removeAt(list, 2);
  assert.equal(removed.role_id, "a");
  assert.deepEqual(items.map((x) => [x.idx, x.role_id]), [[1, "c"], [2, "b"]]);
  assert.throws(() => logic.removeAt(items, 3), UserError);
});

test("required roles: any one is enough, empty means everyone", () => {
  const has = (id) => id === "r2";
  assert.equal(logic.meetsRequired(has, new Set()), true);
  assert.equal(logic.meetsRequired(has, new Set(["r1", "r2"])), true);
  assert.equal(logic.meetsRequired(has, new Set(["r1"])), false);
});

test("dropdown: non-exclusive picks toggle", () => {
  const r = logic.dropdownChanges({ menuRoles: ["a", "b", "c"], held: new Set(["a", "x"]), selected: ["a", "b"], exclusive: false });
  assert.deepEqual(r, { add: ["b"], remove: ["a"] });
});

test("dropdown: exclusive pick replaces, same pick clears", () => {
  const held = new Set(["a", "x"]);
  assert.deepEqual(logic.dropdownChanges({ menuRoles: ["a", "b"], held, selected: ["b"], exclusive: true }), { add: ["b"], remove: ["a"] });
  assert.deepEqual(logic.dropdownChanges({ menuRoles: ["a", "b"], held, selected: ["a"], exclusive: true }), { add: [], remove: ["a"] });
});

test("dropdown: max caps holdings and values not on the menu are ignored", () => {
  assert.throws(
    () => logic.dropdownChanges({ menuRoles: ["a", "b", "c"], held: new Set(["a"]), selected: ["b"], exclusive: false, max: 1 }),
    UserError
  );
  assert.deepEqual(logic.dropdownChanges({ menuRoles: ["a"], held: new Set(), selected: ["zzz"], exclusive: false }), { add: [], remove: [] });
});

test("limits and select bounds", () => {
  assert.deepEqual(logic.checkLimit(0, 3), { min: 0, max: 3 });
  assert.throws(() => logic.checkLimit(4, 3), UserError);
  assert.throws(() => logic.checkLimit(0, 26), UserError);
  assert.deepEqual(logic.selectBounds({ min_values: 2, max_values: null }, 5), { min: 2, max: 5 });
  assert.deepEqual(logic.selectBounds({ min_values: 3, max_values: 10 }, 2), { min: 2, max: 2 });
});

test("buildRows: select first, 5 buttons per row, foreign rows kept, max 5 rows", () => {
  const menu = { placeholder: null, min_values: 0, max_values: null, options: [{ idx: 1, role_id: "1", title: "One", emoji: "😀" }] };
  const buttons = Array.from({ length: 7 }, (_, i) => ({ idx: i + 1, role_id: String(100 + i), label: `B${i}`, style: ButtonStyle.Primary }));
  const foreign = [{ type: 1, components: [{ type: 2, style: 5, label: "Site", url: "https://example.com" }] }];
  const rows = logic.buildRows({ menu, buttons, foreign }).map((r) => r.toJSON());
  assert.equal(rows.length, 4);
  assert.equal(rows[0].components[0].custom_id, "role:d");
  assert.equal(rows[0].components[0].options[0].emoji.name, "😀");
  assert.equal(rows[1].components.length, 5);
  assert.equal(rows[2].components[1].custom_id, "role:b:106");
  assert.equal(logic.isOurRow(rows[1]), true);
  assert.equal(logic.isOurRow(rows[3]), false);
  const many = Array.from({ length: 25 }, (_, i) => ({ idx: i + 1, role_id: String(i), label: "x", style: 1 }));
  assert.throws(() => logic.buildRows({ menu, buttons: many }), UserError);
});

test("db: join roles, reaction roles and cache invalidation", () => {
  assert.equal(store.join.add(G, "r1"), true);
  assert.equal(store.join.add(G, "r1"), false);
  assert.deepEqual(store.join.list(G), ["r1"]);
  store.reaction.set({ guild_id: G, channel_id: "c1", message_id: "m1", emoji_key: "⭐", emoji: "⭐", role_id: "r2" });
  assert.equal(store.state.get(G).reactions.get("m1").get("⭐"), "r2");
  assert.ok(store.state.get(G).messages.has("m1"));
  store.required.set(G, "reaction", "m1", ["r9"]);
  assert.deepEqual([...store.required.get(G, "reaction", "m1")], ["r9"]);
  assert.equal(store.reaction.removeAll(G, "m1"), 1);
  assert.equal(store.state.get(G).reactions.has("m1"), false);
  assert.equal(store.required.get(G, "reaction", "m1").size, 0);
});

test("db: deleting a role cleans every table and reports messages to redraw", () => {
  store.button.replace(G, "m2", [
    { channel_id: "c2", idx: 1, role_id: "gone", label: "Gone", emoji: null, style: 1 },
    { channel_id: "c2", idx: 2, role_id: "keep", label: "Keep", emoji: null, style: 1 },
  ]);
  store.dropdown.create(G, "c3", "m3", { role_id: "gone", title: "Gone" });
  store.join.add(G, "gone");
  const touched = store.forgetRole(G, "gone");
  assert.deepEqual(touched.sort((a, b) => a.messageId.localeCompare(b.messageId)), [
    { messageId: "m2", channelId: "c2" },
    { messageId: "m3", channelId: "c3" },
  ]);
  assert.deepEqual(store.button.forMessage(G, "m2").map((b) => [b.idx, b.role_id]), [[1, "keep"]]);
  assert.equal(store.dropdown.get(G, "m3"), null, "a menu without options is removed");
  assert.ok(!store.join.list(G).includes("gone"));
});

test("db: dropdown update + deleted message is forgotten", () => {
  store.dropdown.create(G, "c4", "m4", { role_id: "a", title: "A" });
  store.dropdown.update(G, "m4", { placeholder: "Pick", min_values: 1, max_values: 2, exclusive: true });
  const menu = store.dropdown.get(G, "m4");
  assert.equal(menu.placeholder, "Pick");
  assert.equal(menu.exclusive, true);
  assert.equal(menu.options.length, 1);
  store.forgetMessage(G, "m4");
  assert.equal(store.dropdown.get(G, "m4"), null);
});

test("command tree is valid and has 29 handlers", () => {
  const command = require("./commands/autorole");
  assert.deepEqual(command.validate(), []);
  assert.equal(Object.keys(command.handlers).length, 29);
  assert.ok(Object.values(command.handlers).every((h) => h.gate === "Manage Guild & Roles"));
});
