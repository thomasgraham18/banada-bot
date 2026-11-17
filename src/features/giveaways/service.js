/**
 * Giveaway operations that touch Discord: posting / re-rendering the message,
 * the Enter button, ending, rerolling. The slash command (commands/giveaways.js)
 * and the scheduler both call into this file.
 *
 * Restart safety:
 *  - the end of every active giveaway is a "giveaways:end" job in the core
 *    scheduler (key = giveaway id), so it fires even after a restart;
 *  - the Enter / Leave buttons go through core.components (prefix "gw"), which
 *    routes by custom ID and needs no in-memory state.
 */
const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { db, scheduler, components, guard, embeds, ui, UserError } = require("../../core");
const store = require("./db");
const logic = require("./logic");

const END_KIND = "giveaways:end";

// ---------------------------------------------------------------- levels (WP10)

/** The levels package api, or null. Looked up lazily: packages load in any order. */
function levelsApi() {
  const api = require("../../handlers/features").api("levels");
  return typeof api?.getLevel === "function" ? api : null;
}

/**
 * The member's level for checkRequirements(): undefined when the giveaway has
 * no level requirement, null when the levels package is missing or fails.
 */
async function levelFor(gw, guildId, userId) {
  if (!logic.hasLevelRequirement(gw)) return undefined;
  const api = levelsApi();
  if (!api) return null;
  try {
    const level = Number(await api.getLevel(guildId, userId));
    return Number.isFinite(level) ? level : 0;
  } catch (err) {
    console.warn(`[giveaways] levels.getLevel failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- lookup

/** A `giveaway` option value -> hydrated giveaway in this guild, or a UserError. */
function resolve(guildId, text) {
  const ref = logic.parseReference(text);
  if (!ref) throw new UserError("Give a giveaway message link or message ID (pick one from the list).");
  const gw = ref.messageId ? store.getByMessage(guildId, ref.messageId) : store.get(ref.id);
  if (!gw || gw.guild_id !== guildId || gw.cancelled || !gw.message_id) throw new UserError("I can't find that giveaway in this server.");
  return gw;
}

const jumpLink = (gw) => `https://discord.com/channels/${gw.guild_id}/${gw.channel_id}/${gw.message_id}`;

// ---------------------------------------------------------------- the message

async function fetchMessage(client, gw) {
  if (!gw?.message_id) return null;
  const channel = await client.channels.fetch(gw.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(gw.message_id).catch(() => null);
}

/**
 * Re-renders the giveaway message from the database.
 * `add`: new files [{ url, name }] to attach (embed images set from an attachment
 * are re-uploaded onto the giveaway message, because interaction attachment URLs
 * expire); `drop`: attachment names to remove. Returns false if the message is gone.
 */
async function refreshMessage(client, gw, { add = [], drop = [] } = {}) {
  const message = await fetchMessage(client, gw);
  if (!message) return false;
  const payload = logic.buildMessage(gw, { defaultColor: embeds.brand(client) });
  if (add.length || drop.length) {
    const replaced = new Set([...drop, ...add.map((f) => f.name)]);
    payload.attachments = [...message.attachments.values()].filter((a) => !replaced.has(a.name));
    payload.files = add.map((f) => ({ attachment: f.url, name: f.name }));
  }
  await message.edit(payload);
  return true;
}

// Entry counts change on every click; batch those edits so a busy giveaway
// doesn't hit the message-edit rate limit.
const pendingRefresh = new Map();
function refreshSoon(client, id, delay = 2500) {
  if (pendingRefresh.has(id)) return;
  const timer = setTimeout(async () => {
    pendingRefresh.delete(id);
    const gw = store.get(id);
    if (gw && !gw.cancelled) await refreshMessage(client, gw).catch((err) => console.warn(`[giveaways] refresh #${id}: ${err.message}`));
  }, delay);
  timer.unref?.();
  pendingRefresh.set(id, timer);
}

/** Posts a new giveaway message and schedules its end. Returns the hydrated giveaway. */
async function start(client, { guild, channel, prize, winners, endsAt, hostId }) {
  const id = store.create({ guildId: guild.id, channelId: channel.id, prize, winners, color: null, endsAt, createdBy: hostId });
  let message;
  try {
    message = await channel.send(logic.buildMessage(store.get(id), { defaultColor: embeds.brand(client) }));
  } catch (err) {
    store.remove(id);
    throw err; // the router translates missing-permission errors
  }
  store.setMessage(id, message.id);
  scheduler.schedule(END_KIND, endsAt, { id }, { guildId: guild.id, key: String(id) });
  return store.get(id);
}

/** Moves the end job after `/giveaways edit duration`. */
const reschedule = (gw) => scheduler.schedule(END_KIND, gw.ends_at, { id: gw.id }, { guildId: gw.guild_id, key: String(gw.id) });

/** Deletes the message and every record of the giveaway, and its job. */
async function cancel(client, gw) {
  scheduler.cancel(END_KIND, String(gw.id));
  const message = await fetchMessage(client, gw);
  await message?.delete().catch(() => {});
  store.remove(gw.id);
}

// ---------------------------------------------------------------- winners

/** Still in the server, not a bot, and still meets the requirements. */
function eligibility(guild, gw) {
  return async (userId) => {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) return false;
    const level = await levelFor(gw, guild.id, userId);
    return logic.checkRequirements(gw, member, { level }).length === 0;
  };
}

/** Announces winners, gives award roles and DMs the hosts (best effort, never throws). */
async function announce(client, gw, guild, winners, { reroll = false } = {}) {
  const message = await fetchMessage(client, gw);
  const mentions = winners.map((id) => `<@${id}>`).join(", ");

  // 1. Public announcement, as a reply to the giveaway message.
  let text;
  if (!winners.length) text = reroll ? `There's nobody left to reroll for **${gw.prize}**.` : `The giveaway for **${gw.prize}** ended with no valid entrants.`;
  else if (gw.hide_winners) text = `The giveaway for **${gw.prize}** has ${reroll ? "been rerolled" : "ended"}. The winner${winners.length === 1 ? " has" : "s have"} been contacted.`;
  else text = reroll ? `🎉 New winner${winners.length === 1 ? "" : "s"}: ${mentions}! You won **${gw.prize}**.` : `🎉 Congratulations ${mentions}! You won **${gw.prize}**.`;
  const payload = { content: text, allowedMentions: { users: gw.hide_winners ? [] : winners } };
  if (message) await message.reply(payload).catch(() => ui.safeSend(message.channel, payload));
  else await ui.safeSend(await client.channels.fetch(gw.channel_id).catch(() => null), payload);

  if (!winners.length) return;

  // 2. Award roles.
  const roles = gw.award_roles.map((id) => guild.roles.cache.get(id)).filter((role) => guard.botCanManageRole(guild, role));
  if (roles.length)
    for (const userId of winners) {
      const member = await guild.members.fetch(userId).catch(() => null);
      await member?.roles.add(roles, `Won giveaway #${gw.id}`).catch((err) => console.warn(`[giveaways] award roles: ${err.message}`));
    }

  // 3. DM the hosts the winners (and, when winners are hidden, the winners themselves).
  const link = jumpLink(gw);
  const hostDm = { embeds: [embeds.info(client, `${reroll ? "Rerolled" : "Winners"} for **${gw.prize}** in **${guild.name}**:\n${mentions}\n\n[Go to giveaway](${link})`, "Giveaway results")] };
  for (const hostId of gw.hosts) await client.users.send(hostId, hostDm).catch(() => {});
  if (gw.hide_winners) {
    const winnerDm = { embeds: [embeds.success(client, `You won **${gw.prize}** in **${guild.name}**! Contact a host to claim it.\n[Go to giveaway](${link})`)] };
    for (const userId of winners) await client.users.send(userId, winnerDm).catch(() => {});
  }
}

/**
 * Ends a giveaway: picks winners, marks it ended, re-renders, announces.
 * Safe to call twice (only the first call does anything). Used by the
 * scheduler and by /giveaways end. Returns the winners, or null if it was
 * already ended / gone.
 */
async function end(client, id) {
  scheduler.cancel(END_KIND, String(id)); // early end: drop the pending job
  const gw = store.get(id);
  if (!gw || gw.ended || gw.cancelled) return null;

  const guild = client.guilds.cache.get(gw.guild_id);
  const winners = guild
    ? await logic.pickWinners(store.listEntries(id), gw.winners, { isEligible: eligibility(guild, gw) })
    : []; // the bot left the server: just close it

  // markEnded only succeeds once, so a manual end racing the scheduler can't double-pick.
  const first = db.transaction(() => {
    if (!store.markEnded(id)) return false;
    store.addWinners(id, winners);
    return true;
  });
  if (!first) return null;
  if (!guild) return winners;

  const ended = store.get(id);
  await refreshMessage(client, ended).catch((err) => console.warn(`[giveaways] end refresh #${id}: ${err.message}`));
  await announce(client, ended, guild, winners);
  return winners;
}

/** Picks `count` new winners among entrants who haven't won yet. */
async function reroll(client, gw, count) {
  if (!gw.ended) throw new UserError("That giveaway hasn't ended yet. End it first with `/giveaways end`.");
  scheduler.cancel(END_KIND, String(gw.id)); // nothing should be pending, but never leave a stale job
  const guild = client.guilds.cache.get(gw.guild_id);
  if (!guild) throw new UserError("I can't reach this server right now.");
  const winners = await logic.pickWinners(store.listEntries(gw.id), count, {
    exclude: store.listWinners(gw.id).map((w) => w.user_id),
    isEligible: eligibility(guild, gw),
  });
  store.addWinners(gw.id, winners, { rerolled: true });
  const updated = store.get(gw.id);
  await refreshMessage(client, updated).catch(() => {});
  await announce(client, updated, guild, winners, { reroll: true });
  return winners;
}

// ---------------------------------------------------------------- scheduler + buttons

scheduler.define(END_KIND, async (job, client) => {
  await end(client, Number(job.payload?.id ?? job.key));
});

const ephemeral = (client, embed, extra = {}) => ({ embeds: [embed], flags: MessageFlags.Ephemeral, ...extra });

async function onButton(interaction, client, [action, rawId]) {
  const id = Number(rawId);
  const gw = store.get(id);
  if (!gw || gw.cancelled) throw new UserError("This giveaway no longer exists.");
  if (gw.ended || gw.ends_at <= Date.now()) throw new UserError("This giveaway has ended.");
  const userId = interaction.user.id;

  if (action === "enter") {
    if (store.hasEntry(id, userId)) {
      // Second click: offer to leave (a persistent button, so it works after restarts too).
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw:leave:${id}`).setLabel("Leave giveaway").setStyle(ButtonStyle.Danger)
      );
      return interaction.reply(ephemeral(client, embeds.warn(client, `You've already entered **${gw.prize}**. Do you want to leave?`), { components: [row] }));
    }
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) throw new UserError("I couldn't load your server profile. Try again.");
    const reasons = logic.checkRequirements(gw, member, { level: await levelFor(gw, gw.guild_id, userId) });
    if (reasons.length) throw new UserError(`You can't enter this giveaway:\n${reasons.map((r) => `• ${r}`).join("\n")}`);
    store.addEntry(id, userId);
    refreshSoon(client, id);
    return interaction.reply(ephemeral(client, embeds.success(client, `You entered the giveaway for **${gw.prize}**. Good luck!`)));
  }

  if (action === "leave") {
    const left = store.removeEntry(id, userId);
    if (left) refreshSoon(client, id);
    return interaction.update({ embeds: [left ? embeds.success(client, `You left the giveaway for **${gw.prize}**.`) : embeds.info(client, "You weren't entered.")], components: [] });
  }
}

/** Called from setup(): registers the persistent "gw" buttons. */
const registerComponents = () => components.register("gw", onButton);

module.exports = {
  END_KIND, levelsApi, resolve, jumpLink, refreshMessage, start, reschedule, cancel, end, reroll, registerComponents,
};
