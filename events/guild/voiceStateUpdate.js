const { PermissionsBitField } = require('discord.js');
const delay = require('delay');
require('dotenv').config();

/**
 * Emited when a voice state is updated.
 * @param {BotClient} client
 * @param {*} oldState
 * @param {*} newState
 * @returns
 */
module.exports = async (client, oldState, newState) => {
	const queue = client.distube.getQueue(newState.guild.id);
	if (!queue) return;

	if (!newState.guild.members.cache.get(client.user.id).voice.channelId) {
		await client.distube.voices.leave(queue.textChannel.guild);
	}

	if (
		newState.channelId &&
		newState.channel.type == 13 &&
		newState.guild.members.me.voice.suppress
	) {
		if (
			newState.guild.members.me.permissions.has(
				PermissionsBitField.Flags.Speak
			) ||
			(newState.channel &&
				newState.channel
					.permissionsFor(nS.guild.members.me)
					.has(PermissionsBitField.Flags.Speak))
		) {
			newState.guild.members.me.voice.setSuppressed(false);
		}
	}

	if (oldState.id === client.user.id) return;
	if (!oldState.guild.members.cache.get(client.user.id).voice.channelId)
		return;

	if (process.env.LEAVE_EMPTY == 'false') return;

	if (
		oldState.guild.members.cache.get(client.user.id).voice.channelId ===
		oldState.channelId
	) {
		if (
			oldState.guild.members.me.voice?.channel &&
			oldState.guild.members.me.voice.channel.members.filter(
				(m) => !m.user.bot
			).size === 0
		) {
			await delay(process.env.LEAVE_EMPTY_TIME);

			const vcMembers =
				oldState.guild.members.me.voice.channel?.members.size;
			if (!vcMembers || vcMembers === 1) {
				if (!queue) return;
				await client.distube.voices.leave(queue.textChannel.guild);
			}
		}
	}
};
