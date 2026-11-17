/**
 * Builds suggestion messages. Pure functions (no Discord calls, no DB), so
 * they are easy to test and every code path renders the same way.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

const DEFAULT_UP = "👍";
const DEFAULT_DOWN = "👎";

/** How many staff responses are shown on the embed (all are stored). */
const MAX_SHOWN_REPLIES = 3;

/**
 * Every status a suggestion can have. "review" means it is waiting in the
 * review channel and is not public yet.
 * `command` is the /suggest subcommand that sets it.
 */
const STATUSES = {
  review: { label: "Awaiting Review", colour: 0xfaa61a },
  pending: { label: "Pending", colour: 0x95a5a6, command: "reset" },
  consideration: { label: "In Consideration", colour: 0xfee75c, command: "consider" },
  progress: { label: "In Progress", colour: 0x3498db, command: "progress" },
  approved: { label: "Approved", colour: 0x57f287, command: "approve" },
  denied: { label: "Denied", colour: 0xed4245, command: "deny" },
};

/** Statuses after which voting is closed. */
const FINAL = new Set(["approved", "denied"]);

/** "/suggest consider" -> "consideration" etc. */
const STATUS_BY_COMMAND = Object.fromEntries(
  Object.entries(STATUSES).filter(([, s]) => s.command).map(([key, s]) => [s.command, key])
);

const statusLabel = (status) => STATUSES[status]?.label ?? status;

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The suggestion embed.
 *   row      suggest_items row
 *   replies  [{ staff_id, comment, created_at }] (newest last)
 *   votes    { up, down } or null (review copies don't show votes)
 *   extra    { replyCount } to say "showing 3 of N"
 */
function buildEmbed(row, { replies = [], votes = null, replyCount = replies.length } = {}) {
  const status = STATUSES[row.status] ?? STATUSES.pending;
  const embed = new EmbedBuilder()
    .setColor(status.colour)
    .setTitle(`Suggestion #${row.id}`)
    .setDescription(truncate(row.content, 4000))
    .setAuthor({ name: truncate(row.author_name ?? "Unknown user", 256), iconURL: row.author_avatar || undefined })
    .addFields({ name: "Status", value: status.label, inline: true })
    .setFooter({ text: `Author ID: ${row.author_id}` })
    .setTimestamp(row.created_at);

  if (votes) {
    const total = votes.up + votes.down;
    const pct = total ? Math.round((votes.up / total) * 100) : 0;
    embed.addFields({ name: "Votes", value: `${votes.up} up · ${votes.down} down${total ? ` (${pct}% positive)` : ""}`, inline: true });
  }
  if (row.updated_by) embed.addFields({ name: "Updated by", value: `<@${row.updated_by}>`, inline: true });

  const shown = replies.slice(-MAX_SHOWN_REPLIES);
  shown.forEach((reply, i) => {
    const older = replyCount - shown.length;
    const name = i === 0 && older > 0 ? `Staff response (${older} older not shown)` : "Staff response";
    embed.addFields({ name, value: truncate(`<@${reply.staff_id}>: ${reply.comment}`, 1024) });
  });
  return embed;
}

/** Up / down vote buttons. Counts on the labels; disabled once a decision is made. */
function voteRow(row, votes, settings) {
  const closed = FINAL.has(row.status);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sugg:vote:up:${row.id}`)
      .setEmoji(settings?.upvote || DEFAULT_UP)
      .setLabel(String(votes.up))
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId(`sugg:vote:down:${row.id}`)
      .setEmoji(settings?.downvote || DEFAULT_DOWN)
      .setLabel(String(votes.down))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed)
  );
}

/** Approve / Deny buttons for the review channel. */
const reviewRow = (row) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sugg:review:approve:${row.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sugg:review:deny:${row.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
  );

/**
 * The full message payload for wherever the suggestion lives:
 * the review copy (Approve/Deny) while status is "review", otherwise the
 * public copy with vote buttons.
 */
function buildMessage(row, { replies, replyCount, votes = { up: 0, down: 0 }, settings } = {}) {
  if (row.status === "review")
    return { embeds: [buildEmbed(row, { replies, replyCount })], components: [reviewRow(row)], allowedMentions: { parse: [] } };
  return {
    embeds: [buildEmbed(row, { replies, replyCount, votes })],
    components: [voteRow(row, votes, settings)],
    allowedMentions: { parse: [] },
  };
}

/** The notice DM'd to the author when staff act on their suggestion. */
function buildNotice(row, guildName, { title, text, link }) {
  const status = STATUSES[row.status] ?? STATUSES.pending;
  return new EmbedBuilder()
    .setColor(status.colour)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(`${text}\n\n> ${truncate(row.content, 500).replace(/\n/g, "\n> ")}${link ? `\n\n[Jump to suggestion](${link})` : ""}`, 4096))
    .setFooter({ text: truncate(guildName, 2048) });
}

/** One autocomplete choice for the `id` option. */
const autocompleteChoice = (row) => ({
  name: truncate(`#${row.id} [${statusLabel(row.status)}] ${row.content.replace(/\s+/g, " ")}`, 100),
  value: row.id,
});

module.exports = {
  DEFAULT_UP,
  DEFAULT_DOWN,
  MAX_SHOWN_REPLIES,
  STATUSES,
  STATUS_BY_COMMAND,
  FINAL,
  statusLabel,
  buildEmbed,
  buildMessage,
  buildNotice,
  voteRow,
  reviewRow,
  autocompleteChoice,
};
