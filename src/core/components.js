/**
 * Routing for persistent buttons / select menus / modals, i.e. components that
 * must keep working after a restart (giveaway "Enter", button roles,
 * suggestion votes, VoiceMaster interface...). Short-lived prompts (pages,
 * confirmations) use collectors in core/ui.js instead.
 *
 * Custom IDs are "<prefix>:<arg>:<arg>..." (max 100 characters):
 *
 *   components.register("gw", async (interaction, client, [action, giveawayId]) => { ... });
 *   new ButtonBuilder().setCustomId(`gw:enter:${id}`)
 *
 * Prefixes must be unique across the bot: use the package name
 * ("gw", "vm", "sugg", "ar", "br"...). "np", "page", "confirm" and "script"
 * are taken by the core / music player.
 */
const { MessageFlags } = require("discord.js");
const embeds = require("./embeds");
const errors = require("./errors");

const RESERVED = new Set(["np", "page", "confirm", "script"]);
const handlers = new Map();

function register(prefix, handler) {
  if (RESERVED.has(prefix) || handlers.has(prefix)) throw new Error(`component prefix "${prefix}" is already taken`);
  if (prefix.includes(":")) throw new Error("component prefixes can't contain ':'");
  handlers.set(prefix, handler);
}

/** Replies with an ephemeral error, whatever state the interaction is in. */
async function replyError(interaction, err, label) {
  const text = errors.describe(err);
  if (!text) console.error(`[${label}] failed:`, err);
  const payload = { embeds: [embeds.error(interaction.client, text ?? "Something went wrong. It has been logged.")], flags: MessageFlags.Ephemeral };
  try {
    // deferReply() sets `ephemeral` (true/false); deferUpdate() leaves it null.
    // After deferReply the "thinking…" message is still open: replace it with
    // the error instead of leaving it stuck. After deferUpdate, editing would
    // overwrite the component's own message, so send a separate follow-up.
    const thinking = interaction.deferred && !interaction.replied && interaction.ephemeral !== null && interaction.ephemeral !== undefined;
    if (thinking) await interaction.editReply({ embeds: payload.embeds, components: [] });
    else if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    /* the interaction expired; nothing else to do */
  }
}

/** Returns true if a registered handler took the interaction. */
async function dispatch(interaction) {
  if (!interaction.customId) return false;
  const [prefix, ...args] = interaction.customId.split(":");
  const handler = handlers.get(prefix);
  if (!handler) return false;
  try {
    await handler(interaction, interaction.client, args);
  } catch (err) {
    await replyError(interaction, err, `component ${prefix}`);
  }
  return true;
}

module.exports = { register, dispatch, replyError };
