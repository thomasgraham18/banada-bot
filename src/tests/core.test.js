/**
 * Offline tests for the core framework. No Discord connection needed.
 *   npm test
 * Uses a throwaway database (DATA_DIR is pointed at a temp folder).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-core-test-"));
const { Collection, PermissionsBitField, PermissionFlagsBits: P, SlashCommandBuilder } = require("discord.js");
const core = require("../core");
const { db, config, parse, script, guard, access, scheduler, defineCommand, UserError } = core;

// ---------------------------------------------------------------- fakes

function fakeGuild(id = "100000000000000001") {
  const roles = new Collection();
  const guild = {
    id, name: "Test Guild", ownerId: "1", memberCount: 42, premiumTier: 2, premiumSubscriptionCount: 7,
    iconURL: () => "https://cdn/icon.png", roles: { cache: roles }, members: { cache: new Collection() },
    client: { colour: "4B0082" },
  };
  return guild;
}

function fakeMember(guild, id, { perms = [], roleIds = [] } = {}) {
  const roles = new Collection(roleIds.map((r) => [r, { id: r }]));
  return {
    id, guild, user: { id, username: `user${id}`, tag: `user${id}`, displayAvatarURL: () => "https://cdn/a.png", createdAt: new Date(0) },
    displayName: `User ${id}`, joinedAt: new Date(), joinedTimestamp: Date.now(),
    permissions: new PermissionsBitField(perms), roles: { cache: roles }, premiumSince: null,
  };
}

// ---------------------------------------------------------------- tests

test("migrations created the core tables and are idempotent", () => {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of ["guild_config", "staff_roles", "fake_permissions", "ignores", "disabled_commands", "scheduled_jobs", "cases", "invoke_messages"])
    assert.ok(tables.includes(t), `missing table ${t}`);
  assert.equal(db.migrate("core_001_init", "SELECT 1"), false);
});

test("guild config round-trips JSON values through the cache", () => {
  config.set("g1", "modlog_channel", "123");
  config.set("g1", "jail_strip_roles", true);
  assert.equal(config.get("g1", "modlog_channel"), "123");
  assert.equal(config.get("g1", "jail_strip_roles"), true);
  assert.equal(config.get("g1", "missing", "fallback"), "fallback");
  config.remove("g1", "modlog_channel");
  assert.equal(config.get("g1", "modlog_channel"), undefined);
});

test("durations, dates and colours parse", () => {
  assert.equal(parse.duration("1h30m"), 5400e3);
  assert.equal(parse.duration("2d 4h"), 2 * 86400e3 + 4 * 3600e3);
  assert.equal(parse.duration("90"), 90 * 60e3);
  assert.throws(() => parse.duration("soon"), UserError);
  assert.throws(() => parse.duration("5x"), UserError);
  assert.equal(parse.formatDuration(5400e3), "1h 30m");
  assert.ok(parse.date("2d").getTime() > Date.now());
  assert.throws(() => parse.date("2001-01-01"), UserError);
  assert.equal(parse.colour("#ff8800"), 0xff8800);
  assert.equal(parse.colour("f80"), 0xff8800);
  assert.equal(parse.colour("red"), 0xed4245);
  assert.throws(() => parse.colour("nope"), UserError);
});

test("emoji and message links parse", () => {
  assert.equal(parse.emoji("⭐").identifier, "⭐");
  assert.equal(parse.emoji("🇨🇦").name, "🇨🇦");
  assert.equal(parse.emoji("👍🏽").name, "👍🏽");
  assert.equal(parse.emoji("<a:party:123456789012345678>").identifier, "a:party:123456789012345678");
  assert.throws(() => parse.emoji("hello"), UserError);
  assert.deepEqual(parse.emojis("⭐ 🍁,<:x:123456789012345678>").map((e) => e.name), ["⭐", "🍁", "x"]);
  assert.deepEqual(parse.messageLink("https://discord.com/channels/1/22222222222222222/33333333333333333"), {
    guildId: "1", channelId: "22222222222222222", messageId: "33333333333333333",
  });
  assert.equal(parse.messageLink("123456789012345678").messageId, "123456789012345678");
  assert.throws(() => parse.messageLink("nope"), UserError);
});

test("scripts render plain text, JSON embeds and variables", () => {
  const guild = fakeGuild();
  const member = fakeMember(guild, "55");
  const plain = script.render("Hi {user.mention} in {guild.name} ({guild.count})", { member, guild });
  assert.equal(plain.content, "Hi <@55> in Test Guild (42)");
  assert.deepEqual(plain.allowedMentions, { parse: [], users: ["55"] });

  const rich = script.render(JSON.stringify({
    content: "Level {level}!",
    embed: { title: "GG {user.name}", color: "#00ff00", fields: [{ name: "XP", value: "{xp}" }], image: "{user.avatar}" },
    buttons: [{ label: "Rules", url: "https://example.com" }],
  }), { member, guild, vars: { level: 5, xp: 1200 } });
  assert.equal(rich.content, "Level 5!");
  assert.equal(rich.embeds[0].data.title, "GG user55");
  assert.equal(rich.embeds[0].data.color, 0x00ff00);
  assert.equal(rich.embeds[0].data.fields[0].value, "1200");
  assert.equal(rich.embeds[0].data.image.url, "https://cdn/a.png");
  assert.equal(rich.components.length, 1);

  assert.equal(script.render("{unknown.var}", {}).content, "{unknown.var}");
  assert.equal(script.render("{user.mention} welcome!", { member, guild }).content, "<@55> welcome!", "text starting with a variable is not JSON");
  assert.throws(() => script.validate('{"content": '), UserError);
});

test("script modal output converts back to a script", () => {
  const fields = (values) => ({ fields: { getTextInputValue: (id) => values[id] ?? "" } });
  assert.equal(script.fromModal(fields({ content: "hello" })), "hello");
  const s = JSON.parse(script.fromModal(fields({ content: "hi", title: "T", color: "red" })));
  assert.deepEqual(s, { content: "hi", embed: { title: "T", color: "#ED4245" } });
  assert.throws(() => script.fromModal(fields({})), UserError);
});

test("guard gates: real, fake, owner, staff", () => {
  const guild = fakeGuild("100000000000000002");
  const owner = fakeMember(guild, "1");
  const admin = fakeMember(guild, "2", { perms: [P.Administrator] });
  const mod = fakeMember(guild, "3", { perms: [P.ManageGuild] });
  const faker = fakeMember(guild, "4", { roleIds: ["r-fake"] });
  const staff = fakeMember(guild, "5", { roleIds: ["r-staff"] });
  const nobody = fakeMember(guild, "6");

  assert.equal(guard.check(nobody, undefined), null);
  assert.equal(guard.check(mod, "Manage Guild"), null);
  assert.ok(guard.check(nobody, "Manage Guild"));
  assert.ok(guard.check(mod, "Manage Guild & Roles"));
  assert.equal(guard.check(admin, "Manage Guild & Roles"), null);
  assert.equal(guard.check(owner, "Server Owner"), null);
  assert.ok(guard.check(admin, "Server Owner"));

  db.run("INSERT INTO fake_permissions (guild_id, role_id, permission) VALUES (?, 'r-fake', 'ManageGuild')", guild.id);
  access.invalidate(guild.id);
  assert.equal(guard.check(faker, "Manage Guild"), null, "fake permission grants the gate");
  assert.ok(guard.check(faker, "Server Owner"), "fake permissions never grant owner");
  assert.ok(guard.check(faker, "Administrator"));

  assert.ok(guard.check(staff, "Staff Only"));
  db.run("INSERT INTO staff_roles (guild_id, role_id) VALUES (?, 'r-staff')", guild.id);
  access.invalidate(guild.id);
  assert.equal(guard.check(staff, "Staff Only"), null);
  assert.equal(guard.check(mod, "Staff Only"), null, "Manage Guild counts as staff");
  assert.equal(guard.check(nobody, "Tier 2 Only"), null, "everyone is premium");
  assert.throws(() => guard.check(nobody, "Made Up Gate"));
});

test("access: ignore, disabled command / module / event", () => {
  const g = "100000000000000003";
  const channel = { id: "c1", isThread: () => false };
  const thread = { id: "t1", parentId: "c1", isThread: () => true };
  const member = { id: "m1", permissions: new PermissionsBitField([]), guild: { ownerId: "x" } };
  const interaction = { guildId: g, member, channel };

  assert.equal(access.commandBlock(interaction, "levels rank", "levels"), null);
  access.setCommand(g, "levels rank", true, { channelId: "c1" });
  assert.match(access.commandBlock(interaction, "levels rank", "levels"), /disabled/);
  assert.equal(access.commandBlock({ ...interaction, channel: { id: "c2", isThread: () => false } }, "levels rank", "levels"), null);
  access.setCommand(g, "levels rank", false, { channelId: "c1" });

  access.setModule(g, "levels", true, "c1");
  assert.match(access.commandBlock({ ...interaction, channel: thread }, "levels rank", "levels"), /module/, "threads inherit");
  assert.equal(access.listenerAllowed({ guildId: g, channel, module: "levels" }), false);
  access.setModule(g, "levels", false, "c1");

  access.setEvent(g, "levels_xp", true);
  assert.equal(access.listenerAllowed({ guildId: g, channel, event: "levels_xp" }), false);
  access.setEvent(g, "levels_xp", false);

  access.setIgnored(g, "m1", "member", true);
  assert.match(access.commandBlock(interaction, "levels rank", "levels"), /ignored/);
  const adminInteraction = { ...interaction, member: { ...member, permissions: new PermissionsBitField([P.Administrator]) } };
  assert.equal(access.commandBlock(adminInteraction, "levels rank", "levels"), null, "admins bypass ignore");
  access.setIgnored(g, "m1", "member", false);

  access.setCommand(g, "levels", true, { channelId: "c1" });
  access.copyChannel(g, "c1", "c9");
  assert.ok(access.commandDisabled(g, "levels rank", { id: "c9", isThread: () => false }), "copy duplicates rows");
});

test("scheduler runs due jobs, repeats, dedupes by key and survives handler errors", async () => {
  const seen = [];
  scheduler.define("test:once", (job) => { seen.push(job.payload.n); });
  let repeats = 0;
  scheduler.define("test:repeat", () => (++repeats < 3 ? Date.now() - 1 : undefined));
  scheduler.define("test:boom", () => { throw new Error("boom"); });

  scheduler.schedule("test:once", Date.now() - 1, { n: 1 }, { key: "a" });
  scheduler.schedule("test:once", Date.now() - 1, { n: 2 }, { key: "a" }); // moves, doesn't duplicate
  scheduler.schedule("test:once", Date.now() + 60_000, { n: 3 });
  scheduler.schedule("test:repeat", Date.now() - 1);
  const boom = scheduler.schedule("test:boom", Date.now() - 1);

  const origWarn = console.warn;
  console.warn = () => {};
  for (let i = 0; i < 3; i++) await scheduler.tick({});
  console.warn = origWarn;

  assert.deepEqual(seen, [2]);
  assert.equal(repeats, 3);
  assert.equal(scheduler.list("test:once").length, 1, "future job still pending");
  const failed = db.get("SELECT attempts, run_at FROM scheduled_jobs WHERE id = ?", boom);
  assert.equal(failed.attempts, 1);
  assert.ok(failed.run_at > Date.now(), "failed job backs off");
});

test("defineCommand validates the tree against its handlers", () => {
  const ok = defineCommand({
    data: new SlashCommandBuilder().setName("demo").setDescription("d")
      .addSubcommand((s) => s.setName("view").setDescription("v"))
      .addSubcommandGroup((g) => g.setName("word").setDescription("w")
        .addSubcommand((s) => s.setName("add").setDescription("a").addStringOption((o) => o.setName("word").setDescription("w").setRequired(true)))),
    handlers: { view: async () => {}, "word add": { gate: "Manage Guild", run: async () => {} } },
  });
  assert.deepEqual(ok.validate(), []);
  assert.equal(ok.manualDefer, true);

  const bad = defineCommand({
    data: new SlashCommandBuilder().setName("bad").setDescription("d").addSubcommand((s) => s.setName("one").setDescription("o")),
    handlers: { two: async () => {} },
  });
  assert.equal(bad.validate().length, 2);
});

test("defineCommand enforces access + gate before running and replies ephemerally on UserError", async () => {
  const replies = [];
  let ran = false;
  const cmd = defineCommand({
    data: new SlashCommandBuilder().setName("gated").setDescription("d").addSubcommand((s) => s.setName("go").setDescription("g")),
    handlers: { go: { gate: "Manage Guild", run: async () => { ran = true; } } },
  });
  const guild = fakeGuild("100000000000000004");
  const interaction = {
    client: guild.client, guild, guildId: guild.id, member: fakeMember(guild, "9"), user: { id: "9" },
    channel: { id: "c", isThread: () => false }, deferred: false, replied: false,
    options: { getSubcommandGroup: () => null, getSubcommand: () => "go" },
    reply: async (p) => { replies.push(p); interaction.replied = true; },
    deferReply: async () => { interaction.deferred = true; },
  };
  await cmd.execute(interaction);
  assert.equal(ran, false);
  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].data.description, /for Admins/);
  assert.ok(replies[0].flags, "ephemeral");

  interaction.member = fakeMember(guild, "9", { perms: [P.ManageGuild] });
  interaction.replied = false;
  await cmd.execute(interaction);
  assert.equal(ran, true);
  assert.equal(interaction.deferred, true);
});
