const { EmbedBuilder } = require('discord.js');

/**
 * Emited when the channel is empty.
 * @param {BotClient} client
 * @param {Queue} client
 *  * @param {Error} error
 */
module.exports = async (client, channel, error) => {
    const embed = new EmbedBuilder()
        .setTitle("** ⁉️ Error occured **")
        .setColor(0xFF0000)
        .setDescription(`${error}`);

    channel.send({ embeds: [embed] });
};
