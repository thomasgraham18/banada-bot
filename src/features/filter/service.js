/**
 * Filter enforcement: what happens when a message or name trips a filter.
 * Used by listeners.js and by the /filter commands (points, names cleanup).
 */
const { PermissionFlagsBits } = require("discord.js");
const { punish, logAction, guard, config } = require("../../core");
const store = require("./db");
const { detect, settingFor, roleExempt, SpamTracker, cleanName, matchWords, findInvite, linkHosts } = require("./match");
const { decayed, addPoints, ladderStep } = require("./points");
const { CHECK_ORDER, EDIT_ORDER, THRESHOLDS, FALLBACK_NAME } = require("./constants");

const spam = new SpamTracker();
// Forget idle spam windows every minute (unref: never keeps the process alive).
setInterval(() => spam.sweep(), 60e3).unref();

/** Owner, administrators and staff (incl. Manage Server) are never filtered. */
const isImmune = (member) => guard.isAdmin(member) || guard.isStaff(member);

/** The channel plus, for threads, the parent (overrides on the parent apply). */
const channelIdsOf = (channel) => [channel?.id, channel?.isThread?.() ? channel.parentId : null].filter(Boolean);

// ------------------------------------------------------------------ points

/** A member's current points with decay applied. */
function getPoints(guildId, userId, now = Date.now()) {
  const row = store.getPointsRow(guildId, userId);
  return row ? decayed(row.points, row.updated_at, now) : 0;
}

/**
 * Adds a filter's points to a member and applies the ladder step it reaches.
 * Returns { before, after, step, result }.
 */
async function applyPoints(member, type, compiled, channel) {
  const now = Date.now();
  const before = getPoints(member.guild.id, member.id, now);
  const after = addPoints(before, compiled.points.get(type) ?? 1, compiled.limit);
  store.savePoints(member.guild.id, member.id, after, now);
  const step = ladderStep(compiled.ladder, before, after, compiled.limit);
  let result = null;
  if (step) {
    result = await punish(member, step.punishment, {
      reason: `Filter points reached ${after} (last hit: ${type})`,
      duration: step.durationMs ?? undefined,
      channel,
    });
  }
  return { before, after, step, result };
}

/** Removes points (all of them when amount is omitted). Returns the new total. */
function removePoints(guildId, userId, amount) {
  const current = getPoints(guildId, userId);
  const next = amount ? Math.max(0, current - amount) : 0;
  store.savePoints(guildId, userId, next);
  return { before: current, after: next };
}

// ------------------------------------------------------------------ messages

/**
 * Runs the filters on a message and punishes the first hit.
 * Hot path: bails out before any work when nothing applies.
 */
async function checkMessage(message, { edited = false } = {}) {
  if (!message.inGuild() || message.author?.bot || message.webhookId || message.system) return;
  const compiled = store.rules.get(message.guildId);
  if (!compiled.active) return;

  let member = message.member;
  if (!member) member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || isImmune(member)) return;

  const channelIds = channelIdsOf(message.channel);
  const roles = [...member.roles.cache.keys()];
  const input = {
    content: message.content ?? "",
    attachments: message.attachments?.size ?? 0,
    stickers: message.stickers?.size ?? 0,
    userKey: `${message.guildId}:${message.author.id}`,
    channelId: message.channelId,
    messageId: message.id,
    now: Date.now(),
  };

  for (const type of edited ? EDIT_ORDER : CHECK_ORDER) {
    const setting = settingFor(compiled, type, channelIds);
    if (!setting || roleExempt(compiled, type, roles)) continue;
    const hit = detect(type, input, setting.threshold, compiled, spam);
    if (!hit) continue;
    await enforce(message, member, type, setting, hit, compiled);
    return true; // a filter hit: the listener marks the message consumed
  }
  return false;
}

/** Deletes, punishes and logs one filter hit. */
async function enforce(message, member, type, setting, hit, compiled) {
  const channel = message.channel;
  const reason = `Filter: ${type} (${hit.detail})`;

  // Spam: also remove the earlier messages of the burst in this channel.
  if (hit.entries?.length > 1 && channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) {
    const ids = hit.entries.filter((e) => e.channelId === channel.id && e.messageId !== message.id).map((e) => e.messageId);
    if (ids.length) await channel.bulkDelete(ids, true).catch(() => {});
  }

  let outcome;
  if (setting.punishment === "points") {
    await punish(member, "delete", { message });
    const p = await applyPoints(member, type, compiled, channel);
    outcome = `+${p.after - p.before} point(s), now ${p.after}${p.step ? ` → ${p.step.punishment}${p.result?.ok ? ` (case #${p.result.case})` : ` failed: ${p.result?.error}`}` : ""}`;
  } else {
    const res = await punish(member, setting.punishment, { reason, duration: setting.durationMs ?? undefined, message, channel });
    outcome = res.ok ? `${setting.punishment}${res.case ? ` (case #${res.case})` : ""}` : `${setting.punishment} failed: ${res.error}`;
  }

  // The punishment service logs cases; this logs every hit with what matched.
  // The match only goes to the modlog (staff), spoilered, never to the channel.
  await logAction(message.guild, "filter", {
    title: `Filter • ${type}`,
    user: message.author,
    colour: 0xfaa61a,
    fields: [
      { name: "Member", value: `<@${member.id}>` },
      { name: "Channel", value: `<#${channel.id}>` },
      { name: "Rule", value: hit.detail },
      ...(hit.match ? [{ name: "Matched", value: `||${String(hit.match).slice(0, 100).replace(/\|/g, "")}||` }] : []),
      { name: "Action", value: outcome.slice(0, 1000), inline: false },
    ],
  });
}

// ------------------------------------------------------------------ names

/**
 * Checks a member's display name against the names filter. Returns
 * { name, reason } when it must change, else null. Doesn't touch Discord.
 */
function nameProblem(member, compiled = store.rules.get(member.guild.id)) {
  if (!compiled.namesActive || member.user?.bot || isImmune(member)) return null;
  const setting = settingFor(compiled, "names", []);
  if (!setting || roleExempt(compiled, "names", [...member.roles.cache.keys()])) return null;
  const autonick = config.get(member.guild.id, config.KEYS.AUTONICK);
  const fallback = typeof autonick === "string" && autonick.trim() ? autonick.trim().slice(0, 32) : FALLBACK_NAME;
  const fix = cleanName(member.displayName, compiled, setting.threshold ?? THRESHOLDS.names.default, fallback);
  return fix && fix.name !== member.displayName ? fix : null;
}

/** Applies nameProblem(). Returns true when the nickname was changed. */
async function enforceName(member) {
  const fix = nameProblem(member);
  if (!fix || !member.manageable) return false;
  try {
    await member.setNickname(fix.name, `Name filter: ${fix.reason}`);
  } catch {
    return false;
  }
  await logAction(member.guild, "filter", {
    title: "Filter • names",
    user: member.user,
    colour: 0xfaa61a,
    fields: [
      { name: "Member", value: `<@${member.id}>` },
      { name: "Reason", value: fix.reason },
      { name: "New name", value: fix.name.replace(/[`|]/g, "") || "-" },
    ],
  });
  return true;
}

// ------------------------------------------------------------------ snipe

/**
 * For the snipe feature (another section): true when a deleted message must
 * be hidden from snipe because of /filter snipe settings.
 */
function hiddenFromSnipe(message) {
  if (!message?.guildId) return false;
  const compiled = store.rules.get(message.guildId);
  if (!compiled.snipe.size) return false;
  const text = message.content ?? "";
  if (compiled.snipe.has("words") && matchWords(compiled.words, text)) return true;
  if (compiled.snipe.has("invites") && findInvite(text)) return true;
  if (compiled.snipe.has("links") && linkHosts(text).length) return true;
  if (compiled.snipe.has("images")) {
    const isImage = (a) => a.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.name ?? "");
    if ([...(message.attachments?.values() ?? [])].some(isImage)) return true;
    if (message.embeds?.some((e) => e.image || e.thumbnail)) return true;
  }
  return false;
}

module.exports = { checkMessage, getPoints, applyPoints, removePoints, nameProblem, enforceName, hiddenFromSnipe, isImmune, spam };
