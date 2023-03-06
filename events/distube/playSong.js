const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require('discord.js');

/**
 * Emited when a song is playing.
 * @param {BotClient} client
 * @param {Queue} client
 * @param {Song} track
 */
module.exports = async (client, queue, track) => {
	var newQueue = client.distube.getQueue(queue.id);
	var data = musicplayer(newQueue, track, client);

	const nowPlaying = await queue.textChannel.send(data);

	const filter = (message) => {
		if (
			message.guild.members.me.voice.channel &&
			message.guild.members.me.voice.channelId ===
				message.member.voice.channelId
		)
			return true;
		else {
			message.reply({
				content: 'You need to be in a same/voice channel.',
				ephemeral: true,
			});
		}
	};

	const collector = nowPlaying.createMessageComponentCollector({
		filter,
		time: 120000,
	});

	collector.on('collect', async (message) => {
		const id = message.customId;

		const queue = client.distube.getQueue(message.guild.id);
		if (id === 'pause') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			if (queue.paused) {
				await client.distube.resume(message.guild.id);
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription(`⏯ | **Song:**  \`Resumed\``);

				message.reply({ embeds: [embed], ephemeral: true });
			} else {
				await client.distube.pause(message.guild.id);
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription(`⏯ | **Song:**  \`Paused\``);

				message.reply({ embeds: [embed], ephemeral: true });
			}
		} else if (id === 'skip') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			if (queue.songs.length === 1 && queue.autoplay === false) {
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription(
						'🚨 | **There are no songs in the queue!**'
					);

				message.reply({ embeds: [embed], ephemeral: true });
			} else {
				await client.distube.skip(message);
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription('⏭ | **Song:**  `Skipped`');

				nowPlaying.edit({ components: [] });
				message.reply({ embeds: [embed], ephemeral: true });
			}
		} else if (id === 'stop') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			await client.distube.voices.leave(message.guild);
			const embed = new EmbedBuilder()
				.setDescription(`🛑 | **Song:**  | \`Stopped\``)
				.setColor(client.colour);

			await nowPlaying.edit({ components: [] });
			message.reply({ embeds: [embed], ephemeral: true });
		} else if (id === 'loop') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			if (queue.repeatMode === 0) {
				client.distube.setRepeatMode(message.guild.id, 1);
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription(`🔁 | **Song is now looping**`);

				message.reply({ embeds: [embed], ephemeral: true });
			} else {
				client.distube.setRepeatMode(message.guild.id, 0);
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription(`🔁 | **Song is no longer looping**`);

				message.reply({ embeds: [embed], ephemeral: true });
			}
		} else if (id === 'previous') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			if (queue.previousSongs.length == 0) {
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription('🚨 | **There are no previous songs!**');

				message.reply({ embeds: [embed], ephemeral: true });
			} else {
				await client.distube.previous(message);
				const embed = new EmbedBuilder()
					.setColor(client.colour)
					.setDescription('⏮ |  **Went back a song**');

				await nowPlaying.edit({ components: [] });
				message.reply({ embeds: [embed], ephemeral: true });
			}
		} else if (id === 'shuffle') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			await client.distube.shuffle(message);
			const embed = new EmbedBuilder()
				.setColor(client.colour)
				.setDescription(`🔀 | **Songs have been shuffled**`);

			message.reply({ embeds: [embed], ephemeral: true });
		} else if (id === 'voldown') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}

			await client.distube.setVolume(message, queue.volume - 10);

			const embed = new EmbedBuilder()
				.setColor(client.colour)
				.setDescription(
					`🔊 | **Decreased volume to:** \`${queue.volume}\`%`
				);

			message.reply({ embeds: [embed], ephemeral: true });
		} else if (id === 'clear') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			await queue.songs.splice(1, queue.songs.length);
			//await client.UpdateQueueMsg(queue);

			const embed = new EmbedBuilder()
				.setDescription(`🍁 | **Queue has been cleared**`)
				.setColor(client.colour);

			message.reply({ embeds: [embed], ephemeral: true });
		} else if (id === 'volup') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			await client.distube.setVolume(message, queue.volume + 10);
			const embed = new EmbedBuilder()
				.setColor(client.colour)
				.setDescription(
					`🔊 | **Increased volume to:** \`${queue.volume}\`%`
				);

			message.reply({ embeds: [embed], ephemeral: true });
		} else if (id === 'queue') {
			// Check if queue is empty
			if (!queue) {
				collector.stop();
			}
			const pagesNum = Math.ceil(queue.songs.length / 10);
			if (pagesNum === 0) pagesNum = 1;

			const songStrings = [];
			for (let i = 1; i < queue.songs.length; i++) {
				const song = queue.songs[i];
				songStrings.push(
					`**${i}.** [${song.name}](${song.url}) \`[${song.formattedDuration}]\` • ${song.user}
          `
				);
			}

			const pages = [];
			for (let i = 0; i < pagesNum; i++) {
				const str = songStrings.slice(i * 10, i * 10 + 10).join('');
				const embed = new EmbedBuilder()
					.setAuthor({
						name: `Queue - ${message.guild.name}`,
						iconURL: message.guild.iconURL({ dynamic: true }),
					})
					.setThumbnail(queue.songs[0].thumbnail)
					.setColor(client.colour)
					.setDescription(
						`**Currently Playing:**\n**[${queue.songs[0].name}](${
							queue.songs[0].url
						})** \`[${queue.songs[0].formattedDuration}]\` • ${
							queue.songs[0].user
						}\n\n**Rest of queue**${
							str == '' ? '  Nothing' : '\n' + str
						}`
					)
					.setFooter({
						text: `Page • ${i + 1}/${pagesNum} | ${
							queue.songs.length
						} • Songs | ${
							queue.formattedDuration
						} • Total duration`,
					});

				pages.push(embed);
			}

			message.reply({ embeds: [pages[0]], ephemeral: true });
		}
	});

	collector.on('end', async (collected, reason) => {
		if (reason === 'time') {
			nowPlaying.edit({ components: [] });
		}
	});
};

function musicplayer(nowQueue, nowTrack, client) {
	const embed = new EmbedBuilder()
		.setAuthor({
			name: `Starting Playing...`,
			iconURL: 'https://cdn.discordapp.com/emojis/741605543046807626.gif',
		})
		.setThumbnail(nowTrack.thumbnail)
		.setColor(client.colour)
		.setDescription(`**[${nowTrack.name}](${nowTrack.url})**`)
		.addFields({
			name: `Uploader:`,
			value: `**[${nowTrack.uploader.name}](${nowTrack.uploader.url})**`,
			inline: true,
		})
		.addFields({
			name: `Requester:`,
			value: `${nowTrack.user}`,
			inline: true,
		})
		.addFields({
			name: `Current Volume:`,
			value: `${nowQueue.volume ?? nowQueue.volume == 50}%`,
			inline: true,
		})
		.addFields({
			name: `Autoplay:`,
			value: `${nowQueue.autoplay ? 'Activated' : 'Not Active'}`,
			inline: true,
		})
		.addFields({
			name: `Total Duration:`,
			value: `${nowQueue.formattedDuration}`,
			inline: true,
		})
		.setTimestamp();

	const row = new ActionRowBuilder()
		.addComponents(
			new ButtonBuilder()
				.setCustomId('pause')
				.setLabel(`Pause`)
				.setEmoji('⏯')
				.setStyle(ButtonStyle.Success)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('previous')
				.setLabel(`Previous`)
				.setEmoji('⬅')
				.setStyle(ButtonStyle.Primary)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('stop')
				.setLabel(`Stop`)
				.setEmoji('✖')
				.setStyle(ButtonStyle.Danger)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('skip')
				.setLabel(`Skip`)
				.setEmoji('➡')
				.setStyle(ButtonStyle.Primary)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('loop')
				.setLabel(`Loop`)
				.setEmoji('🔄')
				.setStyle(ButtonStyle.Success)
		);

	const row2 = new ActionRowBuilder()
		.addComponents(
			new ButtonBuilder()
				.setCustomId('shuffle')
				.setLabel(`Shuffle`)
				.setEmoji(`🔀`)
				.setStyle(ButtonStyle.Primary)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('voldown')
				.setLabel(`Vol -`)
				.setEmoji(`🔉`)
				.setStyle(ButtonStyle.Success)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('clear')
				.setLabel(`Clear`)
				.setEmoji(`🗑`)
				.setStyle(ButtonStyle.Secondary)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('volup')
				.setLabel(`Vol +`)
				.setEmoji(`🔊`)
				.setStyle(ButtonStyle.Success)
		)
		.addComponents(
			new ButtonBuilder()
				.setCustomId('queue')
				.setLabel(`Queue`)
				.setEmoji(`📋`)
				.setStyle(ButtonStyle.Primary)
		);

	return {
		embeds: [embed],
		components: [row, row2],
	};
}
