const { green, blue, magenta } = require('chalk');
const { EmbedBuilder } = require('discord.js'); // Make sure to import the correct classes
const { google } = require('googleapis');

module.exports = async (client) => {
    console.log(
        blue('[INFO] ') + magenta(client.user.tag) + green(' is online!')
    );

    const activities = ['thomasg.ca', 'thomasg.ca/knowledge', '/autoplay', '/help', '/play [song]', '/search [song]', 'Spotify, Soundcloud, YouTube'];
	const youtube = google.youtube({
		version: 'v3',
		auth: client.apiKey,
	});

    // Every 30 minutesP
    setInterval(async () => {

        // Set and change presence
		client.user.setPresence({
			activities: [
				{
					name: `${activities[Math.floor(Math.random() * activities.length)]}`,
					type: 4,
				},
			],
			status: 'online',
		});

        // YouTube Channel Monitor
        try {
            const response = await youtube.search.list({
                part: 'snippet',
                channelId: client.youtubeChannel,
				order: 'Date',
				maxResults: 10,
            });

            const data = response.data.items[0];
			
            const videos = await client.getVideos();

            if (videos.some(video => video.data.id === data.id.videoId)) {
                return;
            } else {
                await client.addVideo(data);

                const channel = client.channels.cache.get(client.discordChannel);
                if (!channel) return;

				const date = new Date(data.snippet.publishTime);
				
                const embed = new EmbedBuilder()
                    .setTitle(`📢🗣️‼️ ${data.snippet.channelTitle} 📢🗣️‼️`)
                    .setColor(0xA020F0)
					.setImage(data.snippet.thumbnails.high.url)
					.setURL(`https://www.youtube.com/watch?v=${data.id.videoId}`)
                    .setDescription(`${data.snippet.title}`)
                    .setTimestamp(date)
					.setFooter({text: `https://www.youtube.com/watch?v=${data.id.videoId}`})

                channel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Error:', error);
        }
    }, 1800000);
};
