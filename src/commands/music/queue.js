const {
  EmbedBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const QueuePage = async (
  message,
  pages,
  timeout,
  queueLength,
  queueDuration
) => {
  if (!message && !message.channel) throw new Error("Channel is inaccessible.");

  if (!pages) throw new Error("Pages are not given.");

  const row1 = new ButtonBuilder()
    .setCustomId("back")
    .setLabel("⬅")
    .setStyle(ButtonStyle.Secondary);
  const row2 = new ButtonBuilder()
    .setCustomId("next")
    .setLabel("➡")
    .setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder().addComponents(row1, row2);

  let page = 0;

  const curPage = await message.editReply({
    embeds: [
      pages[page].setFooter({
        text: `page • ${page + 1}/${
          pages.length
        } | ${queueLength} • songs | ${queueDuration} • total duration`,
      }),
    ],
    components: [row],
    allowedMentions: { repliedUser: false },
  });

  if (pages.length == 0) return;

  const filter = (m) => m.user.id === message.user.id;

  const collector = await curPage.createMessageComponentCollector({
    filter,
    time: timeout,
  });

  collector.on("collect", async (interaction) => {
    if (!interaction.deferred) await interaction.deferUpdate();
    if (interaction.customId === "back") {
      page = page > 0 ? --page : pages.length - 1;
    } else if (interaction.customId === "next") {
      page = page + 1 < pages.length ? ++page : 0;
    }
    curPage.edit({
      embeds: [
        pages[page].setFooter({
          text: `page • ${page + 1}/${
            pages.length
          } | ${queueLength} • songs | ${queueDuration} • total duration`,
        }),
      ],
      components: [row],
    });
  });

  collector.on("end", () => {
    const disabled = new ActionRowBuilder().addComponents(
      row1.setDisabled(true),
      row2.setDisabled(true)
    );
    curPage.edit({
      embeds: [
        pages[page].setFooter({
          text: `page • ${page + 1}/${
            pages.length
          } | ${queueLength} • songs | ${queueDuration} • total duration`,
        }),
      ],
      components: [disabled],
    });
  });

  return curPage;
};

/**
 * @description Show the queue
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the queue")
    .addIntegerOption((option) =>
      option.setName("page").setDescription("Page number to show.")
    ),
  // Command execution
  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: false });

    const args = interaction.options.getInteger("page");

    const queue = client.distube.getQueue(interaction);

    // Check if queue is empty
    if (!queue)
      return interaction.editReply(`There is nothing in the queue right now!`);

    const { channel } = interaction.member.voice;

    // Check if user is in a voice channel
    if (!channel)
      return interaction.editReply("You are not in a voice channel!");

    // Make sure the bot is in the same channel as the user
    if (
      interaction.member.voice.channel !==
      interaction.guild.members.me.voice.channel
    )
      return interaction.editReply(
        "You are not in the same voice channel as me!"
      );

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
      const str = songStrings.slice(i * 10, i * 10 + 10).join("");
      const embed = new EmbedBuilder()
        .setAuthor({
          name: `Queue - ${interaction.guild.name}`,
          iconURL: interaction.guild.iconURL({ dynamic: true }),
        })
        .setThumbnail(queue.songs[0].thumbnail)
        .setColor(client.colour)
        .setDescription(
          `**Currently Playing:**\n**[${queue.songs[0].name}](${
            queue.songs[0].url
          })** \`[${queue.songs[0].formattedDuration}]\` • ${
            queue.songs[0].user
          }\n\n**Rest of queue:**${str == "" ? "  nothing" : "\n" + str}`
        )
        .setFooter({
          text: `page • ${i + 1}/${pagesNum} | ${queue.songs.length} songs | ${
            queue.formattedDuration
          } • total duration`,
        });
      pages.push(embed);
    }

    if (!args) {
      if (pages.length == pagesNum && queue.songs.length > 10)
        QueuePage(
          interaction,
          pages,
          60000,
          queue.songs.length,
          queue.formattedDuration
        );
      else return interaction.editReply({ embeds: [pages[0]] });
    } else {
      if (isNaN(args)) return interaction.editReply("Page must be a number.");
      if (args > pagesNum)
        return interaction.editReply(
          `There are only ${pagesNum} pages available.`
        );
      const pageNum = args == 0 ? 1 : args - 1;
      return interaction.editReply({ embeds: [pages[pageNum]] });
    }
  },
};
