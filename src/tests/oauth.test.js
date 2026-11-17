/**
 * "Connect Discord" (web/oauth.js): which command-menu overwrites a server
 * gets from its Permissions page, token encryption, and callback safety.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-oauth-test-"));
process.env.DISCORD_CLIENT_SECRET = "test-secret";
const log = console.log;
console.log = () => {};
const { loadCommandModules } = require("../handlers/commands");
const commands = new Map(loadCommandModules().map((c) => [c.data.name, c]));
console.log = log;

const { ApplicationCommandPermissionType: T } = require("discord.js");
const { db, guard } = require("../core");
const oauth = require("../web/oauth");

const G = "900000000000000001";
const MOD_ROLE = "900000000000000010";
const ADMIN_ROLE = "900000000000000020";
const ADMIN_USER = "900000000000000030";
const STAFF_ROLE = "900000000000000040";

test("overwrites follow the Permissions page", () => {
  db.run("INSERT INTO access_levels (guild_id, target_id, kind, level) VALUES (?, ?, 'role', 'mod'), (?, ?, 'role', 'admin'), (?, ?, 'user', 'admin')",
    G, MOD_ROLE, G, ADMIN_ROLE, G, ADMIN_USER);
  db.run("INSERT INTO staff_roles (guild_id, role_id) VALUES (?, ?)", G, STAFF_ROLE);
  guard.levels.invalidate(G);

  const want = oauth.desiredOverwrites({ commands }, G);
  const ids = (name) => (want[name] ?? []).map((e) => e.id).sort();

  // Moderator command (/filter): mods, admins (role + user) and staff roles.
  assert.deepEqual(ids("filter"), [ADMIN_ROLE, ADMIN_USER, MOD_ROLE, STAFF_ROLE].sort());
  assert.equal(want.filter.find((e) => e.id === ADMIN_USER).type, T.User);
  // Admin command (/starboard): admins only.
  assert.deepEqual(ids("starboard"), [ADMIN_ROLE, ADMIN_USER].sort());
  // Visible-to-everyone commands get no overwrites at all.
  assert.equal(want.play, undefined);
  assert.equal(want.levels, undefined);

  // Lowering /starboard to members shows it to @everyone (role id = guild id).
  guard.levels.setCommandLevel(G, "starboard", "member");
  assert.deepEqual(oauth.desiredOverwrites({ commands }, G).starboard, [{ id: G, type: T.Role, permission: true }]);
  // Raising /filter to admin drops the moderator role and staff.
  guard.levels.setCommandLevel(G, "filter", "admin");
  assert.deepEqual(oauth.desiredOverwrites({ commands }, G).filter.map((e) => e.id).sort(), [ADMIN_ROLE, ADMIN_USER].sort());
});

test("tokens are encrypted at rest", () => {
  const blob = oauth.encrypt("secret-access-token");
  assert.ok(!blob.includes("secret-access-token"));
  assert.equal(oauth.decrypt(blob), "secret-access-token");
  const tampered = blob.slice(0, -4) + (blob.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => oauth.decrypt(tampered));
});

test("the callback only accepts a state the panel issued, once", async () => {
  const bad = await oauth.handleCallback({}, new URLSearchParams({ state: "made-up", code: "x" }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /expired|wasn't started/);

  const url = new URL(oauth.startUrl(G));
  assert.equal(url.searchParams.get("scope"), "identify applications.commands.permissions.update");
  assert.match(url.searchParams.get("redirect_uri"), /\/oauth\/callback$/);
  const state = url.searchParams.get("state");
  // Discord reports the user cancelled: refused, and the state is now used up.
  const cancelled = await oauth.handleCallback({}, new URLSearchParams({ state, error: "access_denied" }));
  assert.equal(cancelled.ok, false);
  const replay = await oauth.handleCallback({}, new URLSearchParams({ state, code: "x" }));
  assert.match(replay.message, /expired|wasn't started/, "a state can't be used twice");
});

test("status reports setup and connection", () => {
  const st = oauth.status(G);
  assert.equal(st.configured, Boolean(require("../web/oauth").configured()));
  assert.equal(st.connected, false);
  assert.match(st.redirectUri, /^http:\/\/localhost:\d+\/oauth\/callback$|\/oauth\/callback$/);
});
