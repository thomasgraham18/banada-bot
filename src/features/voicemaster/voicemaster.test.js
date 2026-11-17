/**
 * Offline tests for VoiceMaster (no Discord connection).
 * Uses a throwaway database: DATA_DIR is set before core is required.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-voicemaster-test-"));
const { Collection } = require("discord.js");
const { UserError } = require("../../core");
const store = require("./db");
const logic = require("./logic");
const service = require("./service");
const command = require("./commands/voicemaster");
const { onVoiceStateUpdate } = require("./listeners");

const GUILD = "200000000000000001";

function fakeGuild() {
  return {
    id: GUILD, name: "VM Guild", ownerId: "1", memberCount: 10, premiumTier: 0,
    iconURL: () => null, members: { cache: new Collection() }, roles: { cache: new Collection(), everyone: { id: GUILD } },
    channels: { cache: new Collection() }, client: { colour: "4B0082", user: { id: "999" } },
  };
}
function fakeMember(guild, id, { bot = false, channel = null } = {}) {
  return {
    id, guild, user: { id, username: `user${id}`, tag: `user${id}`, bot, createdAt: new Date(0), displayAvatarURL: () => "" },
    displayName: `Nick ${id}`, joinedAt: new Date(), joinedTimestamp: Date.now(),
    roles: { cache: new Collection() }, voice: { channel, channelId: channel?.id ?? null },
  };
}

test("RateLimiter allows `max` hits per window, then reports the wait", () => {
  let now = 0;
  const limiter = new logic.RateLimiter(2, 600_000, () => now);
  assert.equal(limiter.take("c"), 0);
  assert.equal(limiter.take("c"), 0);
  assert.equal(limiter.take("c"), 600_000); // third rename refused
  assert.equal(limiter.take("other"), 0); // keys are independent
  now = 300_000;
  assert.equal(limiter.wait("c"), 300_000);
  now = 600_001; // first hit expired
  assert.equal(limiter.take("c"), 0);
  limiter.undo("c");
  assert.equal(limiter.wait("c"), 0);
});

test("renderName fills the template without mentions and caps at 100 chars", () => {
  const guild = fakeGuild();
  const member = fakeMember(guild, "5");
  assert.equal(logic.renderName(null, member), "Nick 5's channel");
  assert.equal(logic.renderName("{user}  in {guild.name}", member), "Nick 5 in VM Guild");
  assert.equal(logic.renderName("{user.name}", member), "user5");
  assert.equal(logic.renderName("x".repeat(150), member).length, 100);
  assert.equal(logic.renderName("   ", member), "Voice channel");
});

test("bitrate clamps to the guild maximum, limit steps stay in 0-99", () => {
  assert.equal(logic.bitrateFor(64, 96_000), 64_000);
  assert.equal(logic.bitrateFor(384, 96_000), 96_000);
  assert.equal(logic.bitrateFor(2, 96_000), 8000);
  assert.equal(logic.stepLimit(0, -1), 0);
  assert.equal(logic.stepLimit(99, 1), 99);
  assert.equal(logic.stepLimit(undefined, 1), 1);
});

test("isEmptyOfHumans ignores bots (the music player)", () => {
  const members = (...bots) => ({ members: new Collection(bots.map((bot, i) => [String(i), { user: { bot } }])) });
  assert.equal(logic.isEmptyOfHumans(members()), true);
  assert.equal(logic.isEmptyOfHumans(members(true)), true);
  assert.equal(logic.isEmptyOfHumans(members(true, false)), false);
  assert.equal(logic.isEmptyOfHumans(null), true);
});

test("every clear setting maps to a real config column", () => {
  for (const fields of Object.values(logic.CLEAR_SETTINGS))
    for (const column of Object.keys(fields)) assert.ok(store.CONFIG_COLUMNS.has(column), column);
});

test("config and channel rows round-trip through the cache", () => {
  assert.equal(store.getConfig(GUILD), null);
  store.setConfig(GUILD, { hub_channel_id: "10", default_bitrate: 64 });
  assert.equal(store.getConfig(GUILD).hub_channel_id, "10");
  store.setConfig(GUILD, { default_bitrate: null });
  assert.equal(store.getConfig(GUILD).default_bitrate, null);
  assert.equal(store.getConfig(GUILD).hub_channel_id, "10");
  assert.throws(() => store.setConfig(GUILD, { "x; DROP TABLE": 1 }));

  store.addChannel(GUILD, "20", "5");
  assert.equal(store.getChannel(GUILD, "20").owner_id, "5");
  assert.equal(store.ownedBy(GUILD, "5").channel_id, "20");
  store.updateChannel(GUILD, "20", { owner_id: "6", locked: 1 });
  assert.equal(store.getChannel(GUILD, "20").owner_id, "6");
  assert.equal(store.getChannel(GUILD, "20").locked, 1);
  store.removeChannel(GUILD, "20");
  assert.equal(store.getChannel(GUILD, "20"), null);
  store.deleteConfig(GUILD);
  assert.equal(store.getConfig(GUILD), null);
});

test("owner actions check the stored owner, not Discord permissions", () => {
  const guild = fakeGuild();
  const channel = { id: "30", toString: () => "<#30>" };
  store.addChannel(GUILD, "30", "7");
  const owner = fakeMember(guild, "7", { channel });
  const other = fakeMember(guild, "8", { channel });
  const outside = fakeMember(guild, "9");
  assert.equal(service.currentChannel(owner).row.owner_id, "7");
  assert.throws(() => service.currentChannel(other), UserError);
  assert.equal(service.currentChannel(other, { owner: false }).channel, channel);
  assert.throws(() => service.currentChannel(outside), UserError);
  store.removeChannel(GUILD, "30");
});

test("voice listener ignores bots and deletes a temp channel once only bots remain", async () => {
  const guild = fakeGuild();
  let deleted = false;
  const channel = {
    id: "40", name: "vc", guild,
    members: new Collection([["999", { user: { bot: true } }]]), // only the music bot left
    delete: async () => { deleted = true; },
  };
  guild.channels.cache.set("40", channel);
  guild.members.me = { voice: { channelId: null } };
  store.addChannel(GUILD, "40", "7");

  const bot = fakeMember(guild, "999", { bot: true });
  const state = (member, ch) => ({ guild, member, channelId: ch?.id ?? null, channel: ch });
  await onVoiceStateUpdate(guild.client, state(bot, channel), state(bot, null));
  assert.equal(deleted, false, "bot voice changes are ignored");

  const human = fakeMember(guild, "7");
  await onVoiceStateUpdate(guild.client, state(human, channel), state(human, null));
  assert.equal(deleted, true);
  assert.equal(store.getChannel(GUILD, "40"), null);
});

test("/voicemaster tree is valid: 23 top-level entries, 28 handled subcommands", () => {
  assert.deepEqual(command.validate(), []);
  const json = command.data.toJSON();
  assert.equal(json.options.length, 23);
  assert.equal(Object.keys(command.handlers).length, 28);
});

test("interface panel builds valid components with vm: custom ids", () => {
  const guild = fakeGuild();
  const panel = service.buildPanel(guild.client, guild);
  const rows = panel.components.map((r) => r.toJSON());
  assert.equal(rows.length, 5);
  for (const row of rows) for (const c of row.components) assert.match(c.custom_id, /^vm:[a-z]+$/);
  panel.embeds[0].toJSON();
});
