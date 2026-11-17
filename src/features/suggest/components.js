/**
 * Persistent buttons (they keep working after a restart because they are
 * routed by custom ID through core.components, not collectors):
 *
 *   sugg:vote:up:<id>          vote on a public suggestion
 *   sugg:vote:down:<id>
 *   sugg:review:approve:<id>   staff: publish a suggestion waiting in review
 *   sugg:review:deny:<id>      staff: reject it
 */
const { MessageFlags } = require("discord.js");
const { components, guard, UserError } = require("../../core");
const store = require("./db");
const render = require("./render");
const service = require("./service");

async function onVote(interaction, direction, id) {
  const row = store.getSuggestion(interaction.guildId, id);
  if (!row) throw new UserError("That suggestion no longer exists.");
  if (row.status === "review") throw new UserError("That suggestion is still waiting for review.");
  if (render.FINAL.has(row.status)) throw new UserError(`Voting is closed: this suggestion was **${render.statusLabel(row.status)}**.`);

  const result = store.castVote(interaction.guildId, id, interaction.user.id, direction === "up" ? 1 : -1);
  await interaction.update(service.payloadFor(interaction.guildId, row));
  if (result === "removed")
    await interaction.followUp({ content: `Your vote on #${id} was removed.`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function onReview(interaction, action, id) {
  const reason = guard.check(interaction.member, "Staff Only");
  if (reason) throw new UserError(reason);
  const row = store.getSuggestion(interaction.guildId, id);
  if (!row) throw new UserError("That suggestion no longer exists.");
  if (row.status !== "review") {
    // Someone else already handled it (or a status command did): drop the buttons.
    await interaction.update({ components: [] }).catch(() => {});
    throw new UserError(`Suggestion #${id} was already reviewed (now **${render.statusLabel(row.status)}**).`);
  }

  // Publishing can take a moment (send + thread), so acknowledge first.
  await interaction.deferUpdate();
  const guild = interaction.guild;
  const staffId = interaction.user.id;

  if (action === "approve") {
    const { row: published } = await service.approveReview(guild, row, interaction.member);
    const link = service.messageLink(guild.id, published);
    const record = render
      .buildEmbed({ ...published, updated_by: staffId })
      .addFields({ name: "Review", value: `Approved by <@${staffId}>${link ? ` · [view](${link})` : ""}` });
    await interaction.editReply({ embeds: [record], components: [], allowedMentions: { parse: [] } });
    await service.notifyAuthor(interaction.client, guild, published, {
      title: `Your suggestion #${id} was approved`,
      text: `Staff approved your suggestion in **${guild.name}** and it has been posted for voting.`,
    });
    return;
  }

  if (action === "deny") {
    store.setStatus(guild.id, id, "denied", staffId);
    const denied = store.getSuggestion(guild.id, id);
    const record = render.buildEmbed(denied).addFields({ name: "Review", value: `Denied by <@${staffId}>` });
    await interaction.editReply({ embeds: [record], components: [], allowedMentions: { parse: [] } });
    await service.notifyAuthor(interaction.client, guild, { ...denied, message_id: null }, {
      title: `Your suggestion #${id} was denied`,
      text: `Staff reviewed your suggestion in **${guild.name}** and decided not to post it.`,
    });
    return;
  }
  throw new UserError("Unknown review action.");
}

/** Called from index.js setup(). */
function register() {
  components.register("sugg", async (interaction, client, [kind, action, rawId]) => {
    if (!interaction.inGuild()) return;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new UserError("That button is broken (bad suggestion number).");
    if (kind === "vote" && (action === "up" || action === "down")) return onVote(interaction, action, id);
    if (kind === "review") return onReview(interaction, action, id);
    throw new UserError("Unknown suggestion button.");
  });
}

module.exports = { register, onVote, onReview };
