const { ChannelType, PermissionsBitField } = require("discord.js");

// One pending "leave when empty" timer per guild.
const emptyTimers = new Map();

/**
 * Emitted when anyone's voice state changes.
 * Handles: bot kicked from voice, stage channel un-suppress, and the
 * LEAVE_EMPTY / LEAVE_EMPTY_TIME settings (DisTube v5 removed leaveOnEmpty,
 * so it is implemented here).
 * @param {BotClient} client
 * @param {import("discord.js").VoiceState} oldState
 * @param {import("discord.js").VoiceState} newState
 */
module.exports = async (client, oldState, newState) => {
  const guild = newState.guild;
  const me = guild.members.me;
  const queue = client.distube.getQueue(guild.id);
  if (!queue || !me) return;

  // The bot was disconnected from voice: clean up the queue.
  if (!me.voice.channelId) {
    client.distube.voices.leave(guild);
    return;
  }

  // Joined a stage channel as audience: try to become a speaker.
  if (
    newState.id === client.user.id &&
    newState.channel?.type === ChannelType.GuildStageVoice &&
    me.voice.suppress &&
    newState.channel
      .permissionsFor(me)
      ?.has(PermissionsBitField.Flags.Speak)
  ) {
    await me.voice.setSuppressed(false).catch(console.error);
  }

  if (!client.leaveOnEmpty) return;

  const humansInChannel = () =>
    guild.members.me?.voice.channel?.members.filter((m) => !m.user.bot).size ??
    0;

  // Someone is (still) listening: cancel any pending leave.
  if (humansInChannel() > 0) {
    clearTimeout(emptyTimers.get(guild.id));
    emptyTimers.delete(guild.id);
    return;
  }

  if (emptyTimers.has(guild.id)) return;

  emptyTimers.set(
    guild.id,
    setTimeout(() => {
      emptyTimers.delete(guild.id);
      // Re-check: someone may have joined while we were waiting.
      if (humansInChannel() === 0 && client.distube.getQueue(guild.id)) {
        client.distube.voices.leave(guild);
      }
    }, client.leaveOnEmptyTime)
  );
};
