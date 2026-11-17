/**
 * Reaction-role groups (merged from the web panel's colour/icon board):
 * exclusive swaps across messages, stray reactions, required roles, ignoring
 * the bot's own reaction removals, and syncing panel-built menus.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-autorole-groups-"));
const { Collection } = require("discord.js");
const store = require("./db");
const { onReaction } = require("./listeners");

const G = "210000000000000001";
const CH = "210000000000000002";
const MSG1 = "210000000000000011"; // colour menu 1
const MSG2 = "210000000000000012"; // colour menu 2 (same group)
const RED = "210000000000000101";
const BLUE = "210000000000000102";
const GREEN = "210000000000000103";
const BOOSTER = "210000000000000109";

// ---------------------------------------------------------------- fakes

function world() {
  const removedReactions = []; // [messageId, emojiKey, userId]
  const roleObjs = new Collection([RED, BLUE, GREEN, BOOSTER].map((id) => [id, { id, name: `role-${id.slice(-3)}`, managed: false, comparePositionTo: () => -1 }]));
  const guild = {
    id: G, roles: { cache: roleObjs },
    members: { me: { permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } }, fetch: async () => member },
    channels: { cache: new Collection() },
  };
  const held = new Set();
  const member = {
    id: "u1", user: { id: "u1", bot: false, tag: "user#1" }, guild,
    roles: {
      cache: { has: (id) => held.has(id) },
      add: async (r) => held.add(r.id ?? r),
      remove: async (rs) => [].concat(rs).forEach((r) => held.delete(r.id ?? r)),
    },
  };
  const makeMessage = (id) => {
    const message = { id, guildId: G, guild, reactions: { cache: new Collection() } };
    message.reactionFor = (name) => {
      let r = message.reactions.cache.get(name);
      if (!r) {
        r = { emoji: { id: null, name }, message, users: { remove: async (uid) => removedReactions.push([id, name, uid]) } };
        message.reactions.cache.set(name, r);
      }
      return r;
    };
    return message;
  };
  const messages = { [MSG1]: makeMessage(MSG1), [MSG2]: makeMessage(MSG2) };
  guild.channels.cache.set(CH, { messages: { fetch: async (mid) => messages[mid] } });
  const client = { user: { id: "bot" }, guilds: { cache: new Collection([[G, guild]]) } };
  return { client, member, held, messages, removedReactions, user: member.user };
}

const react = (w, messageId, emoji, added = true) => onReaction(w.client, w.messages[messageId].reactionFor(emoji), w.user, added);

function syncColourBoard(required = []) {
  return store.groups.syncManaged(G, "panel", [
    { messageId: MSG1, channelId: CH, group: "panel:colours", exclusive: true, removeUnknown: true, required,
      options: [{ emojiKey: "❤", emoji: "❤️", roleId: RED }, { emojiKey: "💙", emoji: "💙", roleId: BLUE }] },
    { messageId: MSG2, channelId: CH, group: "panel:colours", exclusive: true, removeUnknown: true, required,
      options: [{ emojiKey: "💚", emoji: "💚", roleId: GREEN }] },
  ]);
}

// ---------------------------------------------------------------- tests

test("panel menus sync into the engine and replace their previous sync", () => {
  syncColourBoard();
  const s = store.state.get(G);
  assert.equal(s.reactions.get(MSG1).get("❤"), RED);
  assert.deepEqual(s.groupMessages.get("panel:colours").sort(), [MSG1, MSG2].sort());
  assert.equal(store.groups.managedBy(G, MSG1), "panel");

  // Re-syncing without MSG2 drops it.
  store.groups.syncManaged(G, "panel", [{ messageId: MSG1, channelId: CH, group: "panel:colours", exclusive: true, removeUnknown: true, options: [] }]);
  assert.equal(store.state.get(G).reactions.get(MSG2), undefined);
  syncColourBoard();
});

test("sync never takes over a message /autorole manages itself; reset keeps panel menus", () => {
  const OWN = "210000000000000099";
  store.reaction.set({ guild_id: G, channel_id: CH, message_id: OWN, emoji_key: "⭐", emoji: "⭐", role_id: BLUE });
  store.groups.syncManaged(G, "panel", [
    { messageId: MSG1, channelId: CH, group: "panel:colours", exclusive: true, removeUnknown: true, options: [{ emojiKey: "❤", emoji: "❤️", roleId: RED }] },
    { messageId: OWN, channelId: CH, group: "panel:x", exclusive: false, removeUnknown: false, options: [{ emojiKey: "🔥", emoji: "🔥", roleId: RED }] },
  ]);
  assert.equal(store.state.get(G).reactions.get(OWN).get("⭐"), BLUE, "own message untouched");
  assert.equal(store.groups.managedBy(G, OWN), null);

  store.reaction.reset(G);
  assert.equal(store.state.get(G).reactions.get(OWN), undefined, "reset removes /autorole's own");
  assert.equal(store.state.get(G).reactions.get(MSG1).get("❤"), RED, "reset keeps panel menus");
  syncColourBoard();
});

test("exclusive group: picking another colour swaps roles and reactions across messages", async () => {
  syncColourBoard();
  const w = world();
  await react(w, MSG1, "❤");
  assert.deepEqual([...w.held], [RED]);

  await react(w, MSG2, "💚"); // other message, same group
  assert.deepEqual([...w.held], [GREEN], "red removed, green added");
  assert.deepEqual(w.removedReactions, [[MSG1, "❤", "u1"]], "old reaction taken off");

  // Discord then reports the bot's own removal of ❤: it must not remove anything.
  w.held.add(RED); // pretend they also hold red from elsewhere
  await react(w, MSG1, "❤", false);
  assert.ok(w.held.has(RED), "bot-initiated removal is ignored");

  // A real un-react by the member removes the role.
  await react(w, MSG2, "💚", false);
  assert.ok(!w.held.has(GREEN));
});

test("stray emoji is removed; required role is enforced", async () => {
  syncColourBoard([BOOSTER]);
  const w = world();
  await react(w, MSG1, "🍕");
  assert.deepEqual(w.removedReactions, [[MSG1, "🍕", "u1"]], "stray reaction removed");

  await react(w, MSG1, "❤");
  assert.equal(w.held.has(RED), false, "not a booster: refused");
  assert.deepEqual(w.removedReactions.at(-1), [MSG1, "❤", "u1"]);

  w.held.add(BOOSTER);
  await react(w, MSG1, "❤");
  assert.ok(w.held.has(RED), "booster: allowed");
  syncColourBoard();
});
