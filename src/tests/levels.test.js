/**
 * Access levels (core/levels.js + guard.authorize): who may run what.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-levels-test-"));
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require("discord.js");
const { db, guard } = require("../core");
const levels = guard.levels;

const G = "600000000000000001";
const MOD_ROLE = "600000000000000010";
const ADMIN_ROLE = "600000000000000020";
const guild = { id: G, ownerId: "1" };
const member = (id, { perms = [], roles = [] } = {}) => ({
  id, guild, permissions: new PermissionsBitField(perms), roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) },
});
const assign = (target, kind, level) => {
  db.run("INSERT OR REPLACE INTO access_levels (guild_id, target_id, kind, level) VALUES (?, ?, ?, ?)", G, target, kind, level);
  levels.invalidate(G);
};

test("levels come from panel assignments, staff roles and Discord permissions", () => {
  assign(MOD_ROLE, "role", "mod");
  assign(ADMIN_ROLE, "role", "admin");
  assign("77", "user", "admin");
  assert.equal(levels.memberLevel(member("9")), levels.MEMBER);
  assert.equal(levels.memberLevel(member("1")), levels.OWNER, "server owner");
  assert.equal(levels.memberLevel(member("9", { roles: [MOD_ROLE] })), levels.MOD);
  assert.equal(levels.memberLevel(member("9", { roles: [ADMIN_ROLE] })), levels.ADMIN);
  assert.equal(levels.memberLevel(member("77")), levels.ADMIN, "user assignment");
  assert.equal(levels.memberLevel(member("9", { perms: [P.ManageMessages] })), levels.MOD);
  assert.equal(levels.memberLevel(member("9", { perms: [P.ManageGuild] })), levels.ADMIN);
});

test("default levels follow the gates", () => {
  const gl = (g) => levels.gateLevel(g, guard.PERMISSION_GATES);
  assert.equal(gl(undefined), levels.MEMBER);
  assert.equal(gl("Booster Only"), levels.MEMBER);
  assert.equal(gl("Staff Only"), levels.MOD);
  assert.equal(gl("Manage Channels"), levels.MOD);
  assert.equal(gl("Manage Guild"), levels.ADMIN);
  assert.equal(gl("Manage Guild & Roles"), levels.ADMIN);
  assert.equal(gl("Server Owner"), levels.OWNER);
  assert.equal(levels.bitsLevel(String(P.KickMembers)), levels.MOD);
  assert.equal(levels.bitsLevel(String(P.Administrator)), levels.ADMIN);
  assert.equal(levels.bitsLevel(undefined), levels.MEMBER);
});

test("authorize: panel mods pass mod gates only; Discord perms aren't upgraded", () => {
  const mod = member("9", { roles: [MOD_ROLE] });
  const admin = member("9", { roles: [ADMIN_ROLE] });
  const plain = member("9");
  const msgs = member("9", { perms: [P.ManageMessages] });

  assert.equal(guard.authorize(mod, "filter word add", "Manage Channels"), null, "panel mod runs mod command");
  assert.match(guard.authorize(mod, "starboard set", "Manage Guild"), /Admins/, "mod can't run admin command");
  assert.equal(guard.authorize(admin, "starboard set", "Manage Guild"), null);
  assert.equal(guard.authorize(admin, "autorole add", "Manage Guild & Roles"), null);
  assert.match(guard.authorize(admin, "levels reset", "Server Owner"), /server owner/);
  assert.match(guard.authorize(plain, "filter word add", "Manage Channels"), /Moderators/);
  assert.equal(guard.authorize(plain, "levels rank", undefined), null);
  // Manage Messages makes you a moderator by level, but the finer gate still needs Manage Channels.
  assert.match(guard.authorize(msgs, "filter word add", "Manage Channels"), /Manage Channels/);
});

test("server overrides: lower, raise, most specific wins, owner gates stay", () => {
  const plain = member("9");
  const mod = member("9", { roles: [MOD_ROLE] });

  levels.setCommandLevel(G, "filter word list", "member");
  assert.equal(guard.authorize(plain, "filter word list", "Manage Channels"), null, "lowered to members");
  assert.match(guard.authorize(plain, "filter word add", "Manage Channels"), /Moderators/, "sibling unchanged");

  levels.setCommandLevel(G, "levels", "mod");
  assert.match(guard.authorize(plain, "levels rank", undefined), /Moderators/, "whole command raised");
  levels.setCommandLevel(G, "levels rank", "member");
  assert.equal(guard.authorize(plain, "levels rank", undefined), null, "subcommand override beats command override");

  levels.setCommandLevel(G, "levels reset", "mod");
  assert.match(guard.authorize(mod, "levels reset", "Server Owner"), /server owner/i, "owner-only gates always apply");

  levels.setCommandLevel(G, "skip", "mod");
  assert.match(guard.authorizeClassic(plain, "skip", undefined), /Moderators/, "classic music command");
  assert.equal(guard.authorizeClassic(mod, "skip", undefined), null);
  levels.setCommandLevel(G, "skip", null);
  assert.equal(guard.authorizeClassic(plain, "skip", undefined), null, "override removed");
});

test("panel moderators pass Staff Only and moderation permission checks", () => {
  const mod = member("9", { roles: [MOD_ROLE] });
  assert.equal(guard.check(mod, "Staff Only"), null);
  assert.equal(guard.hasPermission(mod, P.ManageMessages), true);
  assert.equal(guard.hasPermission(mod, P.ManageGuild), false);
  assert.equal(guard.hasPermission(member("9", { roles: [ADMIN_ROLE] }), P.ManageGuild), true);
  assert.equal(guard.hasPermission(member("9", { roles: [ADMIN_ROLE] }), P.Administrator), false, "admin level isn't Discord Administrator");
});
