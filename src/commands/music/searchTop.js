const {
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} = require("discord.js");
const ytsr = require("@distube/ytsr");

/**
 * @description Search and queue song to the top
 */
module.exports = {
  // Slash command properties
  data: new SlashCommandBuilder()
    .setName("searchtop")
    .setDescription("Search and queue song to the top.")
    .addStringOption((option) =>
      option
        .setName("search")
        .setDescription("The song to search")
        .setRequired(true)
    ),
  // Command execution
  async execute(interaction, client) {
    const string = interaction.options.getString("search");

    await interaction.reply(`🔍 **Searching...** \`${string}\``);

    const message = await interaction.fetchReply();

    //? We do this so we can edit the message later
    await client.createPlay(interaction, message.id);

    const { channel } = interaction.member.voice;

    // Check if user is in a voice channel
    if (!channel) {
      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setDescription("No voice channel")
        .setFooter({
          text: `You must be in a voice channel to use this command`,
        });

      await message.edit({
        content: message.content,
        embeds: [embed],
        components: [],
      });

      return;
    }

    if (
      !channel
        .permissionsFor(interaction.guild.members.me)
        .has(PermissionsBitField.Flags.Connect)
    )
      return interaction.editReply(
        `I don't have permission to \`CONNECT\` to ${channel.name}!`
      );

    if (
      !channel
        .permissionsFor(interaction.guild.members.me)
        .has(PermissionsBitField.Flags.Speak)
    )
      return interaction.editReply(
        `I don't have permission to \`SPEAK\` in ${channel.name}!`
      );

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId("one")
          .setEmoji("1️⃣")
          .setStyle(ButtonStyle.Secondary)
      )
      .addComponents(
        new ButtonBuilder()
          .setCustomId("two")
          .setEmoji("2️⃣")
          .setStyle(ButtonStyle.Secondary)
      )
      .addComponents(
        new ButtonBuilder()
          .setCustomId("three")
          .setEmoji("3️⃣")
          .setStyle(ButtonStyle.Secondary)
      )
      .addComponents(
        new ButtonBuilder()
          .setCustomId("four")
          .setEmoji("4️⃣")
          .setStyle(ButtonStyle.Secondary)
      )
      .addComponents(
        new ButtonBuilder()
          .setCustomId("five")
          .setEmoji("5️⃣")
          .setStyle(ButtonStyle.Secondary)
      );

    const options = {
      member: interaction.member,
      textChannel: interaction.channel,
      interaction,
      position: 1,
    };

    const res = await ytsr(string, { safeSearch: false, limit: 5 });

    let index = 1;
    const result = res.items
      .slice(0, 5)
      .map(
        (x) => `**(${index++}.) [${x.name}](${x.url})** Author: \`${x.author}\``
      )
      .join("\n");

    const embed = new EmbedBuilder()
      .setAuthor({
        name: `Song Selection...`,
        iconURL: interaction.guild.iconURL({ dynamic: true }),
      })
      .setColor(client.colour)
      .setDescription(result)
      .setFooter({ text: `Please respond within 30 seconds` });

    await message.edit({
      content: message.content,
      embeds: [embed],
      components: [row],
    });

    const collector = interaction.channel.createMessageComponentCollector({
      filter: (m) => m.user.id === interaction.user.id,
      time: 30000,
      max: 1,
    });

    collector.on("collect", async (interaction) => {
      const id = interaction.customId;
      const loader = new EmbedBuilder().setDescription(
        "**Loading please wait....**"
      );

      if (id === "one") {
        await message.edit({ embeds: [loader], components: [] });
        await client.distube.play(
          interaction.member.voice.channel,
          res.items[0].url,
          options
        );
      } else if (id === "two") {
        await message.edit({ embeds: [loader], components: [] });
        await client.distube.play(
          interaction.member.voice.channel,
          res.items[1].url,
          options
        );
      } else if (id === "three") {
        await message.edit({ embeds: [loader], components: [] });
        await client.distube.play(
          interaction.member.voice.channel,
          res.items[2].url,
          options
        );
      } else if (id === "four") {
        await message.edit({ embeds: [loader], components: [] });
        await client.distube.play(
          interaction.member.voice.channel,
          res.items[3].url,
          options
        );
      } else if (id === "five") {
        await message.edit({ embeds: [loader], components: [] });
        await client.distube.play(
          interaction.member.voice.channel,
          res.items[4].url,
          options
        );
      }
    });

    collector.on("end", async (collected, reason) => {
      if (reason === "time") {
        const embed = new EmbedBuilder()
          .setColor(0xff0000)
          .setDescription("No response")
          .setFooter({ text: `Please respond within 30 seconds` });

        message.edit({
          content: message.content,
          embeds: [embed],
          components: [],
        });
      }
    });
  },
};
