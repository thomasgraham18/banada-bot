/**
 * Offline tests for /boosterrole and /badge: pure logic and storage only.
 *   npm test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "banada-boosterrole-test-"));
const { GuildFeature, Constants } = require("discord.js");
const { UserError } = require("../../core");
const { findBlockedWord, cleanRoleName, decodePng, dominantColour, randomColour } = require("./colour");
const store = require("./db");
const br = require("./roles");
const badge = require("./badge");
const feature = require("./index");

// ---------------------------------------------------------------- PNG fixture

/** Minimal PNG encoder (RGBA or palette) so the decoder can be tested without files. */
function encodePng(width, height, rows, { colourType = 6, palette, filters = [] } = {}) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]); // CRC not checked
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  const bpp = colourType === 6 ? 4 : 1;
  // Apply the requested filter per row (0 none, 1 sub, 2 up) so unfiltering is exercised.
  const raw = [];
  rows.forEach((row, y) => {
    const f = filters[y] ?? 0;
    const prev = y ? rows[y - 1] : Buffer.alloc(row.length);
    const out = Buffer.alloc(row.length);
    for (let x = 0; x < row.length; x++) {
      const left = x >= bpp ? row[x - bpp] : 0;
      out[x] = (row[x] - (f === 1 ? left : f === 2 ? prev[x] : 0)) & 0xff;
    }
    raw.push(Buffer.from([f]), out);
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(palette ? [chunk("PLTE", Buffer.from(palette))] : []),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const rgba = (...px) => Buffer.from(px.flat());

// ---------------------------------------------------------------- tests

test("name filter matches blacklisted words anywhere, case-insensitively", () => {
  assert.equal(findBlockedWord("Super BADGUY", ["bad", "evil"]), "bad");
  assert.equal(findBlockedWord("nice role", ["bad"]), null);
  assert.equal(findBlockedWord("anything", []), null);
  assert.equal(cleanRoleName("  a   b  "), "a b");
  assert.equal(cleanRoleName("x".repeat(150)).length, 100);
});

test("PNG decoder handles RGBA with sub/up filters and palettes", () => {
  const red = [255, 0, 0, 255];
  const blue = [0, 0, 255, 255];
  const png = encodePng(2, 2, [rgba(red, blue), rgba(blue, red)], { filters: [1, 2] });
  const { width, height, pixels } = decodePng(png);
  assert.equal(width, 2);
  assert.equal(height, 2);
  assert.deepEqual([...pixels], [...red, ...blue, ...blue, ...red]);

  const pal = encodePng(2, 1, [Buffer.from([1, 0])], { colourType: 3, palette: [10, 20, 30, 40, 50, 60] });
  assert.deepEqual([...decodePng(pal).pixels], [40, 50, 60, 255, 10, 20, 30, 255]);

  assert.throws(() => decodePng(Buffer.from("not a png")));
});

test("dominant colour ignores transparent, near-black and near-white pixels", () => {
  const px = new Uint8Array([
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, // black (ignored)
    255, 255, 255, 255, 255, 255, 255, 255, // white (ignored)
    200, 50, 50, 0, 200, 50, 50, 0, 200, 50, 50, 0, // transparent red (ignored)
    32, 120, 200, 255, 36, 124, 204, 255, // blue x2: same 16-wide bucket, averaged
    220, 120, 20, 255, // one orange
  ]);
  assert.equal(dominantColour(px), (34 << 16) | (122 << 8) | 202);
  // Only black pixels: falls back to their average instead of null.
  assert.equal(dominantColour(new Uint8Array([0, 0, 0, 255])), 0);
  assert.equal(dominantColour(new Uint8Array([9, 9, 9, 0])), null);
});

test("random colours avoid near-black and near-white", () => {
  const seq = [0, 0.999999, 0.5];
  let i = 0;
  const c = randomColour(() => seq[i++]);
  assert.equal(c, Math.floor(0.5 * 0x1000000));
});

test("colours degrade to solid without Enhanced Role Styles; holographic uses Discord's constants", () => {
  const plain = { features: [] };
  const fancy = { features: [GuildFeature.EnhancedRoleColors] };
  const solid = br.buildColours(plain, 0xff0000, 0x0000ff);
  assert.deepEqual(solid.colors, { primaryColor: 0xff0000, secondaryColor: null, tertiaryColor: null });
  assert.ok(solid.note);
  const gradient = br.buildColours(fancy, 0xff0000, 0x0000ff);
  assert.equal(gradient.colors.secondaryColor, 0x0000ff);
  assert.equal(gradient.note, null);
  const holo = br.buildColours(fancy, null, null, { holo: true });
  assert.deepEqual(holo.colors, {
    primaryColor: Constants.HolographicStyle.Primary,
    secondaryColor: Constants.HolographicStyle.Secondary,
    tertiaryColor: Constants.HolographicStyle.Tertiary,
  });
  assert.throws(() => br.buildColours(plain, null, null, { holo: true }), UserError);
});

test("guild tag detection needs this guild and identityEnabled", () => {
  const user = (pg) => ({ primaryGuild: pg });
  assert.equal(badge.wearsTag(user({ identityGuildId: "g1", identityEnabled: true, tag: "ABC" }), "g1"), true);
  assert.equal(badge.wearsTag(user({ identityGuildId: "g1", identityEnabled: false, tag: "ABC" }), "g1"), false);
  assert.equal(badge.wearsTag(user({ identityGuildId: "g2", identityEnabled: true }), "g1"), false);
  assert.equal(badge.wearsTag(user(null), "g1"), false);
  assert.equal(badge.tagVars(user({ tag: "ABC" })).tag, "ABC");
});

test("booster role storage keeps one role per owner and one owner per role", () => {
  store.roles.set("g", "u1", "r1");
  store.roles.set("g", "u2", "r2");
  assert.equal(store.roles.byOwner("g", "u1"), "r1");
  assert.equal(store.roles.count("g"), 2);
  // Linking r1 to u2 takes it away from u1 and replaces u2's r2.
  store.roles.set("g", "u2", "r1");
  assert.equal(store.roles.byOwner("g", "u1"), null);
  assert.equal(store.roles.ownerOf("g", "r1"), "u2");
  assert.equal(store.roles.count("g"), 1);

  assert.equal(store.shares.add("g", "r1", "m1"), true);
  assert.equal(store.shares.add("g", "r1", "m1"), false);
  assert.deepEqual(store.shares.members("g", "r1"), ["m1"]);
  store.roles.removeRole("g", "r1");
  assert.deepEqual(store.shares.members("g", "r1"), []);
  assert.equal(store.roles.byOwner("g", "u2"), null);
});

test("settings, filter and badge records round-trip through the caches", () => {
  store.settings.set("g", "share_max", 3);
  store.settings.set("g", "award_role_id", "award");
  assert.equal(store.settings.get("g").share_max, 3);
  assert.equal(store.boosterCache.get("g").awardRoleId, "award");
  assert.throws(() => store.settings.set("g", "evil; DROP TABLE x", 1));

  assert.equal(store.filter.add("g", "bad"), true);
  assert.deepEqual(store.filter.list("g"), ["bad"]);
  assert.throws(() => br.assertNameAllowed("g", "so bad"), UserError);

  store.badge.set("g", "enabled", true);
  store.badge.addRole("g", "tagrole");
  assert.equal(store.badge.get("g").enabled, true);
  assert.deepEqual(store.badge.get("g").roleIds, ["tagrole"]);
  assert.equal(store.badge.setMember("g", "u1", true), true);
  assert.equal(store.badge.setMember("g", "u1", true), false);
  assert.ok(store.badge.get("g").members.has("u1"));
  assert.deepEqual(store.badge.enabledGuilds(), ["g"]);
  store.badge.setMember("g", "u1", false);
  assert.equal(store.badge.get("g").members.has("u1"), false);
});

test("command trees are valid and every subcommand has a handler", () => {
  const [boosterrole, badgeCmd] = feature.commands;
  assert.deepEqual(boosterrole.validate(), []);
  assert.deepEqual(badgeCmd.validate(), []);
  assert.equal(Object.keys(boosterrole.handlers).length, 23);
  assert.equal(Object.keys(badgeCmd.handlers).length, 9);
});
