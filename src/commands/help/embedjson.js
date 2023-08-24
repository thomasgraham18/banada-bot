const { SlashCommandBuilder } = require('discord.js');

/**
 * @description Send an embed
 */
module.exports = {
    // The data property provides the command definition for registering to Discord.
    // Slash command properties
    data: new SlashCommandBuilder()
        .setName('embedjson')
        .setDescription('Sends an embed built using https://glitchii.github.io/embedbuilder/')
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('The channel to echo to')
        )
        .addStringOption((option) =>
            option
                .setName('json')
                .setDescription('JSON input for Discord embed')
        ),

    // The execute method, which will contain the functionality to run from our event handler when the command is used.
    // Command execution
    async execute(interaction, client) {
        try {
            const channel = interaction.options.getChannel('channel');
            const json = interaction.options.getString('json');
            console.log(json)
            channel.send(JSON.parse(json));
            await interaction.reply(JSON.parse(json));

        } catch (e) {
            console.log(e);
        }
    },
};
