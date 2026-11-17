/**
 * The web panel's settings schema must match the real tables: every table,
 * column and view query it names has to exist once all packages are loaded.
 * Also round-trips a few values through the engine with a fake guild.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-panel-test-"));
const log = console.log;
console.log = () => {};
require("../handlers/features").loadFeatures(); // runs every migration
console.log = log;

const { Collection } = require("discord.js");
const { db, config } = require("../core");
const panel = require("../web/panel");

const columnsOf = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);

test("every panel section points at real tables, columns and valid SQL", () => {
  const problems = [];
  for (const pkg of panel.PACKAGES)
    pkg.sections.forEach((section, i) => {
      const where = `${pkg.id}#${i} (${section.title})`;
      if (section.kind === "row" || section.kind === "list") {
        const cols = columnsOf(section.table);
        if (!cols.length) return problems.push(`${where}: no table ${section.table}`);
        if (!cols.includes("guild_id")) problems.push(`${where}: ${section.table} has no guild_id`);
        for (const f of section.fields) if (!cols.includes(f.col)) problems.push(`${where}: no column ${section.table}.${f.col}`);
        for (const k of Object.keys(section.keys ?? {})) if (!cols.includes(k)) problems.push(`${where}: no key column ${k}`);
        for (const k of Object.keys(section.auto ?? {})) if (!cols.includes(k)) problems.push(`${where}: no auto column ${k}`);
      }
      if (section.kind === "view") {
        try {
          db.all(section.sql, "1");
        } catch (err) {
          problems.push(`${where}: SQL fails: ${err.message}`);
        }
        if (section.remove) {
          const cols = columnsOf(section.remove.table);
          for (const k of section.remove.keys) if (!cols.includes(k)) problems.push(`${where}: no remove key ${section.remove.table}.${k}`);
        }
      }
      if (section.kind === "config") for (const f of section.fields) if (!f.key) problems.push(`${where}: config field without key`);
    });
  assert.deepEqual(problems, []);
});

test("publicSchema has no functions or SQL", () => {
  const json = JSON.stringify(panel.publicSchema());
  assert.ok(!json.includes("SELECT"), "SQL leaked to the browser schema");
  assert.ok(panel.publicSchema().length >= 13);
});

function fakeGuild() {
  const guild = { id: "300000000000000001", client: null };
  const role = { id: "400000000000000001", name: "Lvl 10", managed: false, hexColor: "#ff0000", comparePositionTo: () => -1 };
  const channel = { id: "500000000000000001", name: "general", isTextBased: () => true, isVoiceBased: () => false, type: 0 };
  guild.roles = { cache: new Collection([[role.id, role]]) };
  guild.channels = { cache: new Collection([[channel.id, channel]]) };
  guild.members = { cache: new Collection(), me: { permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } }, fetch: async () => null };
  guild.client = { commands: new Collection(), emojis: { cache: new Collection() }, users: { cache: new Collection() } };
  return { guild, role, channel };
}

test("engine saves, reads and deletes through the real tables", async () => {
  const { guild, role, channel } = fakeGuild();

  // config section: modlog channel + bool
  const admin = panel.PACKAGES.findIndex((p) => p.id === "server-admin");
  const chIdx = panel.PACKAGES[admin].sections.findIndex((s) => s.title === "Channels & messages");
  await panel.saveSection(guild, "server-admin", chIdx, { modlog_channel: channel.id });
  assert.equal(config.get(guild.id, "modlog_channel"), channel.id);
  // Per-server bot settings: optional booleans/colours, empty = bot-wide default.
  await panel.saveSection(guild, "bot", 0, { music_autoplay: true, bot_colour: "#ff8800", music_default_volume: "", music_leave_empty_ms: "5m" });
  assert.equal(config.get(guild.id, "music_autoplay"), true);
  assert.equal(config.get(guild.id, "bot_colour"), 0xff8800);
  assert.equal(config.get(guild.id, "music_default_volume"), undefined, "empty = removed (bot-wide default)");
  assert.equal(config.get(guild.id, "music_leave_empty_ms"), 300000);
  await assert.rejects(panel.saveSection(guild, "server-admin", chIdx, { modlog_channel: "999999999999999999" }), /isn't in this server/);

  // row section: levels
  await panel.saveSection(guild, "levels", 0, { enabled: true, multiplier: 1.5, message_mode: "dm", stack_roles: false });
  const lv = db.get("SELECT enabled, multiplier, message_mode, stack_roles FROM levels_config WHERE guild_id = ?", guild.id);
  assert.deepEqual(lv, { enabled: 1, multiplier: 1.5, message_mode: "dm", stack_roles: 0 });
  await assert.rejects(panel.saveSection(guild, "levels", 0, { multiplier: 9 }), /at most 3/);

  // list section: level roles, add + upsert + delete
  await panel.addRow(guild, "levels", 1, { level: 10, role_id: role.id });
  await panel.addRow(guild, "levels", 1, { level: 10, role_id: role.id });
  const read = await panel.readPackage(guild, "levels");
  assert.equal(read.sections[1].rows.length, 1);
  assert.equal(read.sections[1].labels[role.id].text, "@Lvl 10");
  await panel.deleteRow(guild, "levels", 1, read.sections[1].rows[0]._key);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM levels_roles WHERE guild_id = ?", guild.id).n, 0);

  // optional key column defaults to '' (filter settings, server-wide)
  const filterIdx = 0;
  await panel.addRow(guild, "filter", filterIdx, { type: "caps", enabled: true, threshold: 80, punishment: "delete" }).catch((e) => {
    // AutoMod sync needs a real guild; the row must still be written.
    if (!/AutoMod/.test(e.message)) throw e;
  });
  assert.equal(db.get("SELECT channel_id, threshold FROM filter_settings WHERE guild_id = ? AND type = 'caps'", guild.id).threshold, 80);

  // scripts are validated
  await assert.rejects(panel.addRow(guild, "config", 1, { channel_id: channel.id, script: '{"content": ' }), /not valid JSON/);
});
