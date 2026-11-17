const { PermissionsBitField } = require("discord.js");

/**
 * Shared implementation for /play, /playskip, /playtop and /banada.
 * The interaction is already deferred by events/guild/interactionCreate.js,
 * so everything here uses editReply.
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {import("../bot")} client
 * @param {string} query URL or search terms
 * @param {{ skip?: boolean, position?: number }} [playOptions] extra DisTube play options
 */
module.exports = async function playRequest(
  interaction,
  client,
  query,
  playOptions = {}
) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel)
    return interaction.editReply("You need to be in a voice channel.");

  const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!perms?.has(PermissionsBitField.Flags.Connect))
    return interaction.editReply(
      `I don't have permission to \`CONNECT\` to ${voiceChannel.name}!`
    );
  if (!perms.has(PermissionsBitField.Flags.Speak))
    return interaction.editReply(
      `I don't have permission to \`SPEAK\` in ${voiceChannel.name}!`
    );

  await interaction.editReply(`🔍 **Searching...** \`${query}\``);

  try {
    // DisTube joins the voice channel itself. Do NOT call joinVoiceChannel /
    // voices.leave here: leaving destroys the existing queue.
    await client.distube.play(voiceChannel, query, {
      member: interaction.member,
      textChannel: interaction.channel,
      // Lets the addSong / addList events edit this reply.
      metadata: { interaction },
      ...playOptions,
    });
  } catch (e) {
    console.error("[play]", e);
    const reason = e?.errorCode
      ? `${e.errorCode}: ${e.message}`
      : "Something went wrong while playing that.";
    await interaction
      .editReply(`❌ ${String(reason).slice(0, 1900)}`)
      .catch(() => {});
  }
};
