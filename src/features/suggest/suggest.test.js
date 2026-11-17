/**
 * Offline tests for /suggest: storage, voting rules, rendering and the
 * command tree. No Discord connection; a throwaway database is used.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-suggest-test-"));
const { Collection } = require("discord.js");
const store = require("./db");
const render = require("./render");
const service = require("./service");
const feature = require("./index");

const G = "200000000000000001";

const fakeMember = (id, roleIds = []) => ({
  id,
  guild: { id: G },
  roles: { cache: new Collection(roleIds.map((r) => [r, { id: r }])) },
});

test("command tree is valid and every subcommand has a handler", () => {
  const [command] = feature.commands;
  assert.deepEqual(command.validate(), []);
  assert.equal(Object.keys(command.handlers).length, 19);
  const json = command.data.toJSON();
  assert.equal(json.name, "suggest");
  assert.equal(json.options.length, 16); // 14 subcommands + 2 groups
});

test("staff commands are gated, create is open to everyone", () => {
  const { handlers } = feature.commands[0];
  for (const k of ["reply", "consider", "reset", "progress", "deny", "approve"]) assert.equal(handlers[k].gate, "Staff Only", k);
  for (const k of ["review set", "review channel", "ignore add", "ignore remove", "ignore list", "config", "lock", "unlock", "set", "clear", "reactions", "threads"])
    assert.equal(handlers[k].gate, "Manage Channels", k);
  assert.equal(handlers.create.gate, undefined);
});

test("suggestions are numbered per guild", () => {
  const a = store.createSuggestion(G, { authorId: "1", authorName: "a", content: "first", status: "pending" });
  const b = store.createSuggestion(G, { authorId: "1", authorName: "a", content: "second", status: "pending" });
  const other = store.createSuggestion("300", { authorId: "1", authorName: "a", content: "elsewhere", status: "pending" });
  assert.equal(b.id, a.id + 1);
  assert.equal(other.id, 1);
});

test("one vote per user; same button removes, other button switches", () => {
  const s = store.createSuggestion(G, { authorId: "1", content: "votes", status: "pending" });
  assert.equal(store.castVote(G, s.id, "u1", 1), "added");
  assert.equal(store.castVote(G, s.id, "u2", 1), "added");
  assert.equal(store.castVote(G, s.id, "u3", -1), "added");
  assert.deepEqual(store.voteCounts(G, s.id), { up: 2, down: 1 });
  assert.equal(store.castVote(G, s.id, "u1", -1), "changed");
  assert.deepEqual(store.voteCounts(G, s.id), { up: 1, down: 2 });
  assert.equal(store.castVote(G, s.id, "u1", -1), "removed");
  assert.deepEqual(store.voteCounts(G, s.id), { up: 1, down: 1 });
});

test("settings default and update through the cache", () => {
  const g = "400";
  assert.equal(store.getSettings(g).channel_id, null);
  assert.equal(store.getSettings(g).locked, 0);
  store.updateSettings(g, { channel_id: "c1", locked: true, nonsense: 1 });
  assert.equal(store.getSettings(g).channel_id, "c1");
  assert.equal(store.getSettings(g).locked, 1);
  store.updateSettings(g, { channel_id: null });
  assert.equal(store.getSettings(g).channel_id, null);
});

test("create is blocked when locked, unconfigured or ignored", () => {
  const g = G;
  const member = fakeMember("m1", ["r1"]);
  assert.match(service.blockReason(member), /aren't set up/);
  store.updateSettings(g, { channel_id: "c1" });
  assert.equal(service.blockReason(member), null);
  store.updateSettings(g, { review_enabled: true });
  assert.match(service.blockReason(member), /review channel/);
  store.updateSettings(g, { review_channel_id: "c2" });
  assert.equal(service.blockReason(member), null);
  store.addIgnore(g, "r1", "role");
  assert.match(service.blockReason(member), /aren't allowed/);
  store.removeIgnore(g, "r1");
  assert.equal(store.addIgnore(g, "m1", "member"), true);
  assert.equal(store.addIgnore(g, "m1", "member"), false, "duplicate");
  assert.match(service.blockReason(member), /aren't allowed/);
  store.removeIgnore(g, "m1");
  store.updateSettings(g, { locked: true });
  assert.match(service.blockReason(member), /locked/);
  store.updateSettings(g, { locked: false, review_enabled: false });
});

test("status commands map to statuses", () => {
  assert.deepEqual(render.STATUS_BY_COMMAND, {
    reset: "pending",
    consider: "consideration",
    progress: "progress",
    approve: "approved",
    deny: "denied",
  });
});

test("embed shows status colour, votes, updater and the last replies", () => {
  const row = { id: 7, author_id: "1", author_name: "alice", content: "Add a music channel", status: "progress", updated_by: "9", created_at: 0 };
  const replies = [1, 2, 3, 4].map((n) => ({ staff_id: "9", comment: `reply ${n}`, created_at: n }));
  const embed = render.buildEmbed(row, { replies, replyCount: 4, votes: { up: 3, down: 1 } }).toJSON();
  assert.equal(embed.title, "Suggestion #7");
  assert.equal(embed.color, render.STATUSES.progress.colour);
  const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Status, "In Progress");
  assert.match(fields.Votes, /3 up · 1 down \(75% positive\)/);
  assert.equal(fields["Updated by"], "<@9>");
  const responses = embed.fields.filter((f) => f.name.startsWith("Staff response"));
  assert.equal(responses.length, render.MAX_SHOWN_REPLIES);
  assert.match(responses[0].name, /1 older/);
  assert.match(responses.at(-1).value, /reply 4/);
});

test("public message has vote buttons, closed once decided; review has approve/deny", () => {
  const row = { id: 3, author_id: "1", content: "x", status: "pending", created_at: 0 };
  const settings = { upvote: "<:yes:123456789012345678>", downvote: null };
  const open = render.buildMessage(row, { votes: { up: 2, down: 0 }, settings });
  const buttons = open.components[0].toJSON().components;
  assert.deepEqual(buttons.map((b) => b.custom_id), ["sugg:vote:up:3", "sugg:vote:down:3"]);
  assert.equal(buttons[0].label, "2");
  assert.equal(buttons[0].emoji.id, "123456789012345678");
  assert.equal(buttons[1].emoji.name, render.DEFAULT_DOWN);
  assert.equal(buttons[0].disabled, false);

  const closed = render.buildMessage({ ...row, status: "denied" }, { votes: { up: 0, down: 0 } });
  assert.ok(closed.components[0].toJSON().components.every((b) => b.disabled));

  const review = render.buildMessage({ ...row, status: "review" });
  assert.deepEqual(review.components[0].toJSON().components.map((b) => b.custom_id), ["sugg:review:approve:3", "sugg:review:deny:3"]);
  assert.ok(!review.embeds[0].toJSON().fields.some((f) => f.name === "Votes"));
});

test("autocomplete choices fit Discord's limits", () => {
  const choice = render.autocompleteChoice({ id: 12, status: "consideration", content: "a ".repeat(200) });
  assert.ok(choice.name.length <= 100);
  assert.ok(choice.name.startsWith("#12 [In Consideration]"));
  assert.equal(choice.value, 12);
  const found = store.searchSuggestions(G, "second");
  assert.ok(found.some((r) => r.content === "second"));
});

test("replies are stored and returned newest-last", () => {
  const s = store.createSuggestion(G, { authorId: "1", content: "replies", status: "pending" });
  for (const n of [1, 2, 3, 4, 5]) store.addReply(G, s.id, "9", `c${n}`);
  assert.equal(store.countReplies(G, s.id), 5);
  assert.deepEqual(store.latestReplies(G, s.id, 3).map((r) => r.comment), ["c3", "c4", "c5"]);
});

test("vote button updates the message in place and refuses closed suggestions", async () => {
  const { onVote } = require("./components");
  const s = store.createSuggestion(G, { authorId: "1", content: "button", status: "pending" });
  const sent = [];
  const interaction = (userId) => ({
    guildId: G,
    user: { id: userId },
    update: async (payload) => sent.push(payload),
    followUp: async (payload) => sent.push(payload),
  });
  await onVote(interaction("u1"), "up", s.id);
  assert.equal(sent.at(-1).components[0].toJSON().components[0].label, "1");
  await onVote(interaction("u1"), "up", s.id); // second click on the same button removes it
  assert.match(sent.at(-1).content, /removed/);
  assert.deepEqual(store.voteCounts(G, s.id), { up: 0, down: 0 });

  store.setStatus(G, s.id, "approved", "9");
  await assert.rejects(onVote(interaction("u2"), "down", s.id), /Voting is closed/);
});
