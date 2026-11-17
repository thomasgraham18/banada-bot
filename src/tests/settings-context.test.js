/**
 * Per-server settings: client.colour / defaultVolume / leaveOn* return the
 * current server's override inside core/context.run(), else the bot-wide value.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-settings-test-"));
const hasConfig = fs.existsSync(path.join(__dirname, "..", "config.json"));

test("per-server overrides resolve through the async context", { skip: !hasConfig && "needs src/config.json" }, async () => {
  const settings = require("../utils/settings");
  const context = require("../core/context");
  const { config } = require("../core");
  const client = {};
  settings.load(client);
  settings.update(client, { colour: "111111", defaultVolume: 100, leaveOnStop: false });

  const A = "800000000000000001";
  const B = "800000000000000002";
  config.set(A, "bot_colour", 0xff8800);
  config.set(A, "music_default_volume", 40);
  config.set(A, "music_leave_stop", true);

  assert.equal(client.colour, "111111", "outside any server: bot-wide");
  await context.run(A, async () => {
    await new Promise((r) => setTimeout(r, 5)); // survives awaits and timers
    assert.equal(client.colour, "FF8800");
    assert.equal(client.defaultVolume, 40);
    assert.equal(client.leaveOnStop, true);
  });
  context.run(B, () => {
    assert.equal(client.colour, "111111", "server without overrides: bot-wide");
    assert.equal(client.defaultVolume, 100);
  });
  assert.equal(context.guildIdOf([{ id: A, songs: [], voiceChannel: null }]), A, "DisTube queue");
  assert.equal(context.guildIdOf([null, { guild: { id: B } }]), B);
  assert.throws(() => { client.colour = "000000"; }, /read-only/);
});
