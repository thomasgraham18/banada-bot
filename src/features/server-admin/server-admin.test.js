/**
 * Offline tests for server-admin: the zip writer, settings helpers, the
 * command trees and the honeypot cache. No Discord connection.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-admin-test-"));
const { zip, zipSize, splitForLimit, uniqueNames, crc32 } = require("./zip");

/** Minimal zip reader (central directory) to check what zip() wrote. */
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const localNameLen = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    out.push({ name, data, crc });
    p += 46 + nameLen;
  }
  return out;
}

test("crc32 matches known values (and zlib's when available)", () => {
  assert.equal(crc32(Buffer.from("")), 0);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  if (typeof zlib.crc32 === "function") {
    const buf = Buffer.from("The quick brown fox jumps over the lazy dog 🦊");
    assert.equal(crc32(buf), zlib.crc32(buf));
  }
});

test("zip() round-trips files, sizes and UTF-8 names", () => {
  const files = [
    { name: "a.png", data: Buffer.from([1, 2, 3, 4]) },
    { name: "smile 😀.gif", data: Buffer.alloc(1000, 7) },
    { name: "empty.json", data: Buffer.alloc(0) },
  ];
  const buf = zip(files);
  assert.equal(buf.length, zipSize(files));
  const read = readZip(buf);
  assert.deepEqual(read.map((f) => f.name), files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) {
    assert.ok(read[i].data.equals(files[i].data));
    assert.equal(read[i].crc, crc32(files[i].data));
  }
  assert.equal(zip([]).length, 22); // just the end record
});

test("splitForLimit keeps every zip under the limit and reports oversize files", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.png`, data: Buffer.alloc(300) }));
  const big = { name: "huge.png", data: Buffer.alloc(5000) };
  const limit = 1000;
  const { groups, tooLarge } = splitForLimit([...files, big], limit);
  assert.deepEqual(tooLarge.map((f) => f.name), ["huge.png"]);
  assert.equal(groups.flat().length, 10);
  for (const g of groups) {
    assert.ok(zipSize(g) <= limit, `group of ${g.length} is ${zipSize(g)} bytes`);
    assert.ok(zip(g).length <= limit);
  }
  assert.ok(groups.length > 1);
});

test("uniqueNames sanitises and de-duplicates", () => {
  const out = uniqueNames([{ name: "a.png" }, { name: "A.png" }, { name: "b/c.png" }, { name: "a.png" }]);
  assert.deepEqual(out.map((e) => e.name), ["a.png", "A_2.png", "b_c.png", "a_3.png"]);
});

test("settings helpers describe values and cover every clear choice", () => {
  const { CLEARABLE, describeValue, configLines, MODERATION_KEYS } = require("./settings");
  const { config } = require("../../core");
  assert.equal(Object.keys(CLEARABLE).length, 12);
  for (const key of Object.values(CLEARABLE)) assert.ok(Object.values(config.KEYS).includes(key));
  assert.equal(describeValue(config.KEYS.MUTED_ROLE, "123"), "<@&123>");
  assert.equal(describeValue(config.KEYS.MODLOG_CHANNEL, "456"), "<#456>");
  assert.equal(describeValue("x", true), "✅ on");
  assert.equal(describeValue("x", undefined), "*not set*");
  assert.match(describeValue("x", "a`b".repeat(50)), /^`[^`]+…`$/);
  const lines = configLines({ [config.KEYS.DJ_ROLE]: "9", levels_custom: 5 });
  assert.ok(lines.some((l) => l.includes("<@&9>")));
  assert.ok(lines.at(-1).startsWith("**levels_custom**"));
  assert.ok(!MODERATION_KEYS.includes(config.KEYS.MUSIC_AUTOPLAY));
});

test("command trees are valid and every subcommand is handled", () => {
  const feature = require("./index");
  const names = feature.commands.map((c) => c.data.name).sort();
  assert.deepEqual(names, ["access", "antiraid", "channel", "emoji", "ignore", "invoke", "settings", "sticker"]);
  let subs = 0;
  for (const command of feature.commands) {
    assert.deepEqual(command.validate(), [], `/${command.data.name}`);
    subs += Object.keys(command.handlers).length;
  }
  // Hidden from regular members by the lowest access level of their subcommands
  // (mod = Manage Messages, admin = Manage Server); /channel has a public subcommand.
  const visibility = Object.fromEntries(feature.commands.map((c) => [c.data.name, c.data.toJSON().default_member_permissions ?? null]));
  assert.deepEqual(visibility, {
    access: "8192", antiraid: "32", channel: null, emoji: "32", ignore: "32", invoke: "32", settings: "8192", sticker: "32",
  });
  assert.equal(subs, 22 + 3 + 14 + 3 + 3 + 2 + 1 + 1);
});

test("honeypot cache follows writes; staff + fake permission writes reach the guard", () => {
  const store = require("./db");
  const { guard } = require("../../core");
  const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require("discord.js");
  const g = "200000000000000001";
  assert.equal(store.honeypots.get(g).size, 0);
  store.honeypots.add(g, "c1", "ban", "u");
  assert.equal(store.honeypots.get(g).get("c1"), "ban");
  store.honeypots.add(g, "c1", "kick", "u");
  assert.equal(store.honeypots.get(g).get("c1"), "kick");
  assert.equal(store.honeypots.remove(g, "c1"), true);
  assert.equal(store.honeypots.get(g).size, 0);

  const member = {
    id: "5", guild: { id: g, ownerId: "1" }, permissions: new PermissionsBitField([]),
    roles: { cache: new Collection([["r1", { id: "r1" }]]) },
  };
  assert.equal(guard.isStaff(member), false);
  store.staff.set(g, "r1", true);
  assert.equal(guard.isStaff(member), true);
  store.staff.clear(g);
  assert.equal(guard.isStaff(member), false);

  assert.equal(guard.check(member, "Manage Guild") !== null, true);
  store.fake.add(g, "r1", [guard.FAKEABLE.manage_guild]);
  assert.equal(guard.check(member, "Manage Guild"), null);
  assert.notEqual(guard.check(member, "Server Owner"), null); // fake perms never grant owner
  assert.equal(guard.hasPermission(member, P.ManageRoles), false);
  assert.equal(store.fake.reset(g), 1);
  assert.notEqual(guard.check(member, "Manage Guild"), null);
});

test("autonick substitutes variables and respects the 32 character limit", () => {
  const { autonickFor } = require("./listeners");
  const { Collection } = require("discord.js");
  const member = {
    id: "7",
    guild: { id: "g", name: "G", memberCount: 3, iconURL: () => null, members: { cache: new Collection() }, roles: { cache: new Collection() } },
    user: { id: "7", username: "alice", tag: "alice", displayAvatarURL: () => "", createdAt: new Date(0) },
    displayName: "Alice", joinedAt: new Date(), joinedTimestamp: Date.now(),
  };
  assert.equal(autonickFor("[new] {user.name}", member), "[new] alice");
  assert.equal(autonickFor("x".repeat(40), member).length, 32);
});
