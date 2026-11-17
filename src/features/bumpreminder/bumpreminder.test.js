/**
 * Offline tests for /bumpreminder. Uses a throwaway database.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-bump-test-"));
const { Collection, PermissionsBitField, PermissionFlagsBits: P } = require("discord.js");
const { scheduler } = require("../../core");
const logic = require("./logic");
const store = require("./db");
const service = require("./service");
const command = require("./commands/bumpreminder");

const { DISBOARD_ID, detectBump } = logic;

/** A DISBOARD reply as a plain object (same shape as a discord.js Message). */
const disboard = (overrides = {}) => ({
  author: { id: DISBOARD_ID },
  channelId: "c1",
  embeds: [{ description: "[Bump done! :thumbsup:](https://disboard.org/)\nCheck it out on DISBOARD." }],
  interactionMetadata: { user: { id: "77" } },
  ...overrides,
});

test("detectBump: DISBOARD's success embed counts, with the bumper from interactionMetadata", () => {
  assert.deepEqual(detectBump(disboard()), { bumperId: "77" });
  assert.deepEqual(detectBump(disboard(), { channelId: "c1" }), { bumperId: "77" });
});

test("detectBump: falls back to the deprecated message.interaction for the bumper", () => {
  const msg = disboard({ interactionMetadata: null, interaction: { commandName: "bump", user: { id: "88" } } });
  assert.deepEqual(detectBump(msg), { bumperId: "88" });
  assert.deepEqual(detectBump(disboard({ interactionMetadata: undefined })), { bumperId: null });
});

test("detectBump: rejects other authors, channels, commands and failed bumps", () => {
  assert.equal(detectBump(disboard({ author: { id: "123" } })), null, "not DISBOARD");
  assert.equal(detectBump(disboard(), { channelId: "other" }), null, "wrong channel");
  assert.equal(detectBump(disboard({ embeds: [{ description: "Please wait another 87 minutes until the server can be bumped" }] })), null);
  assert.equal(detectBump(disboard({ embeds: [] })), null);
  assert.equal(detectBump(disboard({ interaction: { commandName: "help", user: { id: "1" } } })), null, "other command");
  assert.equal(detectBump(null), null);
  // EmbedBuilder-style objects keep the description under .data
  assert.deepEqual(detectBump(disboard({ embeds: [{ data: { description: "bump DONE!" } }] })), { bumperId: "77" });
});

test("overwriteState reads allow / deny / inherit", () => {
  const ow = { allow: new PermissionsBitField([P.SendMessages]), deny: new PermissionsBitField([P.UseApplicationCommands]) };
  assert.equal(logic.overwriteState(ow, P.SendMessages), true);
  assert.equal(logic.overwriteState(ow, P.UseApplicationCommands), false);
  assert.equal(logic.overwriteState(ow, P.AttachFiles), null);
  assert.equal(logic.overwriteState(undefined, P.SendMessages), null);
});

test("pingable reminders mention the last bumper only when the script mentions nobody", () => {
  assert.deepEqual(logic.reminderMentions(false), { parse: [] });
  assert.deepEqual(logic.reminderMentions(true), { parse: ["users", "roles"] });
  assert.equal(logic.withPing({ content: "Bump!" }, true, "5").content, "<@5> Bump!");
  assert.equal(logic.withPing({ content: "<@&9> Bump!" }, true, "5").content, "<@&9> Bump!");
  assert.equal(logic.withPing({ content: "​", embeds: [{}] }, true, "5").content, "<@5>");
  assert.equal(logic.withPing({ content: "Bump!" }, false, "5").content, "Bump!");
});

test("scripts: NULL means default, empty thank-you means off", () => {
  assert.equal(logic.reminderScript({ reminder_script: null }), logic.DEFAULT_REMINDER);
  assert.equal(logic.reminderScript({ reminder_script: "hi" }), "hi");
  assert.equal(logic.thankyouScript({ thankyou_script: null }), logic.DEFAULT_THANKYOU);
  assert.equal(logic.thankyouScript({ thankyou_script: "" }), null);
});

test("settings upsert and the cache refreshes on write", () => {
  assert.equal(store.get("g-db").enabled, false);
  store.update("g-db", { enabled: true, channel_id: "c9" });
  assert.equal(store.get("g-db").enabled, true);
  assert.equal(store.get("g-db").channel_id, "c9");
  assert.throws(() => store.update("g-db", { nope: 1 }));
});

test("command tree is valid with 11 subcommands, all gated on Manage Channels", () => {
  assert.deepEqual(command.validate(), []);
  assert.equal(Object.keys(command.handlers).length, 11);
  for (const h of Object.values(command.handlers)) assert.equal(h.gate, "Manage Channels");
});

// ---------------------------------------------------------------- end to end with fakes

function fakeWorld(guildId) {
  const sent = [];
  const edits = [];
  const guild = {
    id: guildId, name: "Bump Guild", memberCount: 10, ownerId: "1",
    iconURL: () => "", roles: { everyone: { id: guildId } },
    members: { me: { id: "bot" }, cache: new Collection(), fetch: async () => { throw new Error("unknown member"); } },
  };
  const existing = { allow: new PermissionsBitField([P.SendMessages]), deny: new PermissionsBitField() };
  const channel = {
    id: "bump-ch", name: "bump", guild,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => { sent.push(payload); return payload; },
    permissionOverwrites: { cache: new Map([[guildId, existing]]), edit: async (_target, values) => { edits.push(values); } },
  };
  const client = {
    user: { id: "bot" },
    channels: { fetch: async () => channel },
    users: { fetch: async (id) => ({ id, username: `u${id}`, tag: `u${id}` }) },
  };
  const message = {
    ...disboard({ channelId: channel.id }),
    id: "m1", guildId, guild, channel,
  };
  return { sent, edits, guild, channel, client, message };
}

test("a bump thanks the bumper, locks, schedules the reminder; the reminder unlocks and pings", async () => {
  const guildId = "g-e2e";
  const w = fakeWorld(guildId);
  store.update(guildId, { enabled: true, channel_id: w.channel.id, autolock: true, pingable: true, reminder_script: "Time to bump {last_bumper}!" });

  const bump = detectBump(w.message, { channelId: w.channel.id });
  await service.handleBump(w.client, w.message, bump);

  assert.equal(w.sent.length, 1, "thank-you sent");
  assert.match(w.sent[0].embeds[0].data.description, /<@77>/);
  assert.deepEqual(w.edits[0], { SendMessages: false, UseApplicationCommands: false }, "locked");
  assert.equal(store.get(guildId).last_bumper_id, "77");

  const job = service.pendingJob(guildId);
  assert.ok(job, "reminder scheduled");
  assert.ok(Math.abs(job.run_at - (Date.now() + logic.BUMP_COOLDOWN_MS)) < 5000, "about 2 hours out");
  assert.deepEqual(job.payload.restore, { SendMessages: true, UseApplicationCommands: null });

  // A second bump moves the same job and keeps the original pre-lock state.
  await service.handleBump(w.client, { ...w.message, id: "m2" }, { bumperId: "78" });
  assert.equal(scheduler.list(service.KIND, guildId).length, 1);
  assert.deepEqual(service.pendingJob(guildId).payload.restore, { SendMessages: true, UseApplicationCommands: null });
  assert.equal(w.edits.length, 1, "not locked twice");

  await service.remind(service.pendingJob(guildId), w.client);
  assert.deepEqual(w.edits.at(-1), { SendMessages: true, UseApplicationCommands: null }, "unlocked to the original state");
  const reminder = w.sent.at(-1);
  assert.equal(reminder.content, "Time to bump <@78>!");
  assert.deepEqual(reminder.allowedMentions, { parse: ["users", "roles"] });
});

test("turning reminders off cancels the pending reminder and unlocks", async () => {
  const guildId = "g-off";
  const w = fakeWorld(guildId);
  store.update(guildId, { enabled: true, channel_id: w.channel.id, autolock: true, thankyou_script: "" });
  await service.handleBump(w.client, w.message, { bumperId: "77" });
  assert.equal(w.sent.length, 0, "thank-you switched off");
  assert.ok(service.pendingJob(guildId));

  await service.cancel(w.client, guildId);
  assert.equal(service.pendingJob(guildId), null);
  assert.deepEqual(w.edits.at(-1), { SendMessages: true, UseApplicationCommands: null });
});
