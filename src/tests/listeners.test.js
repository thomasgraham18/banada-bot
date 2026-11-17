/**
 * core/listeners: priority order and "consumed" messages (a message the
 * filter deleted must not also get an autoresponder reply or XP).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-listeners-test-"));
const listeners = require("../core/listeners");

test("listeners run by priority; consumed messages skip later listeners unless `always`", async () => {
  const ran = [];
  listeners.on("messageCreate", { name: "xp" }, () => ran.push("xp"));
  listeners.on("messageCreate", { name: "autoresponder" }, () => ran.push("autoresponder"));
  listeners.on("messageCreate", { name: "audit", always: true }, () => ran.push("audit"));
  listeners.on("messageCreate", { name: "filter", priority: 10 }, (_c, message) => {
    ran.push("filter");
    if (message.content.includes("spam")) listeners.consume(message);
  });

  const handlers = {};
  listeners.attach({ on: (event, fn) => (handlers[event] = fn) });

  await handlers.messageCreate({ id: "1", content: "hello" });
  assert.deepEqual(ran, ["filter", "xp", "autoresponder", "audit"], "filter first, then registration order");

  ran.length = 0;
  await handlers.messageCreate({ id: "2", content: "buy spam now" });
  assert.deepEqual(ran, ["filter", "audit"], "consumed: only `always` listeners still run");
  assert.equal(listeners.isConsumed({ id: "2" }), true);
});
