/**
 * Watches the bump channel:
 *   - DISBOARD's "Bump done" reply -> service.handleBump()
 *   - autoclean: anything else (not DISBOARD, not this bot) is deleted after
 *     a few seconds.
 *
 * Settings come from the guildCache in db.js, so there is no DB query per
 * message. Registered with module/event "bumpreminder" so /access and
 * /ignore can switch it off per channel.
 */
const { PermissionFlagsBits: P } = require("discord.js");
const { listeners, scheduler } = require("../../core");
const store = require("./db");
const logic = require("./logic");
const service = require("./service");

// DISBOARD may post a placeholder and then edit in the result, so we also
// check edits. Remember which messages were handled so a bump counts once.
const handled = new Set();
const remember = (id) => {
  handled.add(id);
  if (handled.size > 500) handled.delete(handled.values().next().value);
};

async function checkBump(client, message) {
  if (!message.inGuild() || handled.has(message.id)) return false;
  const settings = store.get(message.guildId);
  if (!settings.enabled || !settings.channel_id) return false;
  const bump = logic.detectBump(message, { channelId: settings.channel_id });
  if (!bump) return false;
  remember(message.id);
  await service.handleBump(client, message, bump);
  return true;
}

function autoclean(client, message) {
  if (!message.inGuild() || message.system) return;
  const settings = store.get(message.guildId);
  if (!settings.enabled || !settings.autoclean || message.channelId !== settings.channel_id) return;
  if (message.author.id === logic.DISBOARD_ID || message.author.id === client.user.id) return;
  if (!message.channel.permissionsFor(message.guild.members.me)?.has(P.ManageMessages)) return;
  scheduler.deleteMessageLater(message, logic.AUTOCLEAN_DELAY_MS);
}

module.exports = function setupListeners() {
  const opts = { module: "bumpreminder", event: "bumpreminder" };

  listeners.on("messageCreate", { name: "bumpreminder:message", ...opts }, async (client, message) => {
    if (await checkBump(client, message)) return;
    autoclean(client, message);
  });

  listeners.on("messageUpdate", { name: "bumpreminder:edit", ...opts }, async (client, _old, message) => {
    if (!message.guildId) return;
    const settings = store.get(message.guildId);
    if (!settings.enabled || message.channelId !== settings.channel_id) return;
    // Uncached messages arrive as partials without an author: fetch those
    // (only in the bump channel, so this stays cheap).
    if (message.partial) message = await message.fetch().catch(() => null);
    if (message?.author?.id === logic.DISBOARD_ID) await checkBump(client, message);
  });
};
