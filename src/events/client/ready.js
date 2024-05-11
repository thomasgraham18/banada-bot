const { green, blue, magenta } = require("chalk");
const { EmbedBuilder } = require("discord.js");

module.exports = async (client) => {
  console.log(
    blue("[INFO] ") + magenta(client.user.tag) + green(" is online!")
  );

  const activities = [
    "thomasg.ca",
    "thomasg.ca/knowledge",
    "/autoplay",
    "/help",
    "/play [song]",
    "/search [song]",
    "Spotify, Soundcloud, YouTube",
  ];

  const guild = client.guilds.cache.get("724081792658964593"); // Use your guild ID here
  if (!guild) return console.error("Guild not found!");

  const channel = guild.channels.cache.get("726031585362706472"); // Use your voice channel ID here
  if (!channel) return console.error("Channel not found!");

  const embed = new EmbedBuilder()
    .setTitle("Commands")
    .setDescription(
      client.commands
        .map((cmd) => ` \r\n \`${cmd.data.name} - ${cmd.data.description}\``)
        .join(", ")
    )
    .setColor(client.colour);

  channel
    .send({ embeds: [embed] })
    .then(() => console.log("Embed sent successfully!"))
    .catch(console.error);

  // Every 30 minutes
  setInterval(async () => {
    // Set and change presence
    client.user.setPresence({
      activities: [
        {
          name: `${activities[Math.floor(Math.random() * activities.length)]}`,
          type: 4,
        },
      ],
      status: "online",
    });
  }, 90000);

  setInterval(async () => {
    channel
      .send({ embeds: [embed] })
      .then(() => console.log("Embed sent successfully!"))
      .catch(console.error);
  }, 86400000);
};
