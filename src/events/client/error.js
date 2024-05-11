const { EmbedBuilder } = require("discord.js");
const { red, blue } = require("chalk");

module.exports = async (client, channel, error) => {
  console.log(
    red(`[ERROR] `) +
      "An error event was sent by Discord.js: \n" +
      blue("[INFO]: ") +
      client.user.tag +
      " " +
      client.user.id +
      " " +
      blue("[ERROR]: ") +
      error
  );
};
