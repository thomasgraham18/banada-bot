/**
 * Pure giveaway logic: winner selection, entry requirements and the giveaway
 * message layout. Nothing here talks to Discord or the database, so it is
 * unit-tested offline (logic.test.js).
 */
const crypto = require("crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

const DAY_MS = 86_400_000;
const MAX_WINNERS = 50;

// ---------------------------------------------------------------- winners

/**
 * Picks up to `count` unique winners from `entrants`.
 *
 * - `exclude`: user IDs that can't win (e.g. people who already won, for rerolls).
 * - `isEligible(userId)`: optional (async) check run on each candidate when it
 *   is drawn: still in the server, still meets the requirements. Ineligible
 *   candidates are skipped and another one is drawn.
 * - `randomInt(n)`: injectable for tests; defaults to crypto.randomInt, which is
 *   uniform and unpredictable (Math.random is neither guaranteed to be).
 *
 * This is a lazy Fisher-Yates shuffle: each draw takes a random index from the
 * remaining pool and swaps it out, so nobody is drawn twice and only as many
 * eligibility checks run as needed. With fewer eligible entrants than winners,
 * everyone eligible wins.
 */
async function pickWinners(entrants, count, { exclude = [], isEligible, randomInt = crypto.randomInt } = {}) {
  const excluded = new Set(exclude);
  const pool = [...new Set(entrants)].filter((id) => !excluded.has(id));
  const winners = [];
  let remaining = pool.length;
  while (winners.length < count && remaining > 0) {
    const index = randomInt(remaining);
    const candidate = pool[index];
    // Move the drawn candidate out of the live part of the array.
    pool[index] = pool[remaining - 1];
    remaining--;
    if (!isEligible || (await isEligible(candidate))) winners.push(candidate);
  }
  return winners;
}

// ---------------------------------------------------------------- requirements

/** True when the giveaway has a level requirement (needs the levels package). */
const hasLevelRequirement = (gw) => Boolean(gw.min_level || gw.max_level);

/**
 * Returns the reasons `member` can't enter `gw` (empty array = allowed).
 *
 * `gw`: { required_roles[], min_level, max_level, min_age_days, min_stay_days }
 * `member`: a GuildMember (or a fake with roles.cache.has, user.createdTimestamp, joinedTimestamp)
 * `level`: the member's level, `null` if the levels package isn't available,
 *          or undefined when the giveaway has no level requirement.
 *
 * Required roles: the member needs **all** of them (guide: deduced).
 */
function checkRequirements(gw, member, { level, now = Date.now() } = {}) {
  const reasons = [];
  const missing = (gw.required_roles ?? []).filter((id) => !member.roles.cache.has(id));
  if (missing.length) reasons.push(`You need ${missing.length === 1 ? "the role" : "all of these roles:"} ${missing.map((id) => `<@&${id}>`).join(", ")}.`);

  if (hasLevelRequirement(gw)) {
    if (level == null) reasons.push("This giveaway has a level requirement, but the levels system isn't available right now.");
    else {
      if (gw.min_level && level < gw.min_level) reasons.push(`You need to be at least level **${gw.min_level}** (you're level ${level}).`);
      if (gw.max_level && level > gw.max_level) reasons.push(`You must be level **${gw.max_level}** or lower (you're level ${level}).`);
    }
  }

  if (gw.min_age_days) {
    const created = member.user?.createdTimestamp ?? 0;
    if (now - created < gw.min_age_days * DAY_MS)
      reasons.push(`Your account must be at least **${gw.min_age_days}** day${gw.min_age_days === 1 ? "" : "s"} old.`);
  }
  if (gw.min_stay_days) {
    const joined = member.joinedTimestamp ?? now; // unknown join time counts as "just joined"
    if (now - joined < gw.min_stay_days * DAY_MS)
      reasons.push(`You must have been in this server for at least **${gw.min_stay_days}** day${gw.min_stay_days === 1 ? "" : "s"}.`);
  }
  return reasons;
}

/** Human-readable requirement lines for the giveaway embed. */
function requirementLines(gw) {
  const lines = [];
  if (gw.required_roles?.length) lines.push(`Roles: ${gw.required_roles.map((id) => `<@&${id}>`).join(" ")}`);
  if (gw.min_level && gw.max_level) lines.push(`Level: ${gw.min_level}–${gw.max_level}`);
  else if (gw.min_level) lines.push(`Level: ${gw.min_level}+`);
  else if (gw.max_level) lines.push(`Level: ${gw.max_level} or lower`);
  if (gw.min_age_days) lines.push(`Account age: ${gw.min_age_days}+ days`);
  if (gw.min_stay_days) lines.push(`In server: ${gw.min_stay_days}+ days`);
  return lines;
}

// ---------------------------------------------------------------- references

/**
 * What the user typed for a `giveaway` option -> { id } (internal id, e.g. "#12"
 * or "12") or { messageId } (message ID or link). Returns null if unusable.
 */
function parseReference(text) {
  const input = String(text ?? "").trim();
  const link = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/(\d+)/.exec(input);
  if (link) return { messageId: link[1] };
  if (/^\d{15,25}$/.test(input)) return { messageId: input };
  const internal = /^#?(\d{1,12})$/.exec(input);
  if (internal) return { id: Number(internal[1]) };
  return null;
}

// ---------------------------------------------------------------- message layout

const ts = (ms, style = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const isUrl = (text) => /^https?:\/\/\S+$/i.test(String(text ?? ""));

/**
 * The giveaway message: embed + Enter button.
 * `gw` is a hydrated row (db.get): hosts, required_roles, winner_ids, entry_count.
 */
function buildMessage(gw, { defaultColor = 0x580476 } = {}) {
  const lines = [];
  if (gw.description) lines.push(gw.description, "");

  if (gw.ended) {
    lines.push(`**Ended:** ${ts(gw.ended_at ?? gw.ends_at)}`);
    if (gw.hide_winners) lines.push("**Winners:** hidden");
    else if (gw.winner_ids?.length) lines.push(`**Winners:** ${gw.winner_ids.map((id) => `<@${id}>`).join(", ")}`);
    else lines.push("**Winners:** nobody (no valid entrants)");
  } else {
    lines.push(`**Ends:** ${ts(gw.ends_at)} (${ts(gw.ends_at, "f")})`);
    lines.push(`**Winners:** ${gw.winners}`);
  }
  if (gw.hosts?.length) lines.push(`**Hosted by:** ${gw.hosts.map((id) => `<@${id}>`).join(", ")}`);
  lines.push(`**Entries:** ${gw.entry_count ?? 0}`);

  const requirements = requirementLines(gw);
  if (requirements.length && !gw.ended) lines.push("", "**Requirements**", ...requirements.map((l) => `• ${l}`));

  const embed = new EmbedBuilder()
    .setTitle(String(gw.prize).slice(0, 256))
    .setDescription(lines.join("\n").slice(0, 4096))
    .setColor(gw.ended ? 0x2b2d31 : gw.color ?? defaultColor)
    .setFooter({ text: `Giveaway #${gw.id}${gw.ended ? " • Ended" : ""}` })
    .setTimestamp(gw.ended ? gw.ended_at ?? gw.ends_at : gw.ends_at);
  // attachment://… references and http(s) URLs are both valid embed images.
  if (gw.image) embed.setImage(gw.image);
  if (gw.thumbnail) embed.setThumbnail(gw.thumbnail);

  const button = new ButtonBuilder()
    .setCustomId(`gw:enter:${gw.id}`)
    .setEmoji("🎉")
    .setLabel(gw.ended ? `Ended (${gw.entry_count ?? 0})` : `Enter (${gw.entry_count ?? 0})`)
    .setStyle(gw.ended ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(Boolean(gw.ended)); // setDisabled(undefined) would disable it

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

module.exports = {
  DAY_MS, MAX_WINNERS, pickWinners, hasLevelRequirement, checkRequirements, requirementLines,
  parseReference, buildMessage, isUrl, ts,
};
