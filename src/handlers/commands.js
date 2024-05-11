const chillout = require("chillout");
const readdirRecursive = require("recursive-readdir");
const { resolve, relative } = require("path");
const { green, blue, magenta, red } = require("chalk");

/**
 * @description Loads all commands in a recursive manner
 * @param {BotClient} client
 */
module.exports = async (client) => {
  let commandsPath = resolve("./commands");
  let commandFiles = await readdirRecursive(commandsPath);

  await chillout.forEach(commandFiles, (commandFile) => {
    const startTime = Date.now();
    const relativePath = relative(__dirname, commandFile);
    const command = require(commandFile);

    // Set a new item in the Collection with the key as the command name and the value as the exported module
    if ("data" in command && "execute" in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.log(
        `[WARNING] The command at ${relativePath} is missing a required "data" or "execute" property.`
      );
    }

    console.log(
      `${green("[SUCCESS]")} Loaded command ${magenta(
        command.data.name
      )} in ${magenta(Date.now() - startTime)}${magenta("ms")}.`
    );
  });

  if (client.commands.size > 0) {
    console.log(
      `${blue("[INFO]")} ${magenta(
        client.commands.size
      )} slash commands loaded.`
    );
  } else {
    console.log(red("[ERROR] No slash commands loaded. UH OH RAGGY!"));
  }
};
