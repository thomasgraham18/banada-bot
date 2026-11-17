/**
 * Shared by /emoji extract and /sticker extract: download every asset, pack
 * them into STORE zips that each fit the upload limit, and post them.
 */
const { StickerFormatType, PermissionFlagsBits: P } = require("discord.js");
const { guard, embeds, ensure } = require("../../core");
const { zip, splitForLimit, uniqueNames } = require("./zip");

const DEFAULT_LIMIT = 10 * 1024 * 1024;
const CONCURRENCY = 6;

/**
 * Bytes we may upload in this guild. discord.js 14.28 has no
 * guild.maximumUploadLimit; use it if a later version adds it, else 10 MB
 * (the limit every server gets, so it's always safe). A little headroom is
 * kept for the multipart request.
 */
const uploadLimit = (guild) => (Number(guild.maximumUploadLimit) || DEFAULT_LIMIT) - 16 * 1024;

/** Downloads [{ name, url }] -> [{ name, data }], a few at a time. Failures are collected. */
async function downloadAll(items) {
  const files = [];
  const failed = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      try {
        const res = await fetch(item.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        files.push({ name: item.name, data: Buffer.from(await res.arrayBuffer()) });
      } catch {
        failed.push(item.name);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  // Keep the original order regardless of which download finished first.
  const order = new Map(items.map((it, i) => [it.name, i]));
  files.sort((a, b) => order.get(a.name) - order.get(b.name));
  return { files, failed };
}

const STICKER_EXT = {
  [StickerFormatType.PNG]: "png",
  [StickerFormatType.APNG]: "png",
  [StickerFormatType.Lottie]: "json",
  [StickerFormatType.GIF]: "gif",
};

/** [{ name, url }] for every custom emoji (names made unique before downloading). */
async function emojiItems(guild) {
  const emojis = await guild.emojis.fetch();
  return uniqueNames(
    [...emojis.values()].map((e) => ({ name: `${e.name}.${e.animated ? "gif" : "png"}`, url: e.imageURL({ extension: e.animated ? "gif" : "png", size: 4096 }) }))
  );
}

async function stickerItems(guild) {
  const stickers = await guild.stickers.fetch();
  return uniqueNames(
    [...stickers.values()].map((s) => ({ name: `${s.name}.${STICKER_EXT[s.format] ?? "png"}`, url: s.url }))
  );
}

/**
 * The whole /emoji|sticker extract flow. `kind` is "emoji" or "sticker".
 * The command is already deferred.
 */
async function extract(interaction, ctx, kind) {
  guard.assertBotPermissions(ctx.channel, [P.AttachFiles, P.SendMessages]);
  const items = kind === "emoji" ? await emojiItems(ctx.guild) : await stickerItems(ctx.guild);
  ensure(items.length, `This server has no ${kind === "emoji" ? "emojis" : "stickers"}.`);

  const { files, failed } = await downloadAll(items);
  ensure(files.length, `I couldn't download any ${kind === "emoji" ? "emojis" : "stickers"}. Try again later.`);

  const { groups, tooLarge } = splitForLimit(files, uploadLimit(ctx.guild));
  const base = `${ctx.guild.name.replace(/[^\w-]+/g, "_").slice(0, 40) || "server"}_${kind === "emoji" ? "emojis" : "stickers"}`;
  const notes = [
    `**${files.length}** ${kind === "emoji" ? "emoji" : "sticker"}${files.length === 1 ? "" : "s"} in ${groups.length} zip file${groups.length === 1 ? "" : "s"}.`,
    failed.length ? `Couldn't download: ${failed.slice(0, 15).join(", ")}${failed.length > 15 ? "…" : ""}` : null,
    tooLarge.length ? `Too large to upload: ${tooLarge.map((f) => f.name).join(", ")}` : null,
  ].filter(Boolean);

  for (let i = 0; i < groups.length; i++) {
    const name = groups.length === 1 ? `${base}.zip` : `${base}_part${i + 1}.zip`;
    const payload = { files: [{ attachment: zip(groups[i]), name }] };
    if (i === 0) await ctx.reply({ ...payload, embeds: [embeds.success(ctx.client, notes.join("\n"))] });
    else await interaction.followUp(payload);
  }
}

module.exports = { extract, uploadLimit, downloadAll };
