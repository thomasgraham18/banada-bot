const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

/**
 * @description Enables autoplay
 */
module.exports = {
    // Slash command properties
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List of commands'),

    // Command execution
    async execute(interaction, client) {

		await interaction.deferReply({ ephemeral: false });
        
        const embed = new EmbedBuilder()
            .setTitle('Commands')
            .setDescription(client.commands.map(cmd => ` \r\n \`${cmd.data.name} - ${cmd.data.description}\``).join(', '))
            .setColor(client.colour)

        interaction.editReply({ embeds: [embed] });
    }
}