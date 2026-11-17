const { InteractionContextType } = require("discord.js");
const { green, blue, magenta, red, yellow } = require("chalk");
const { featureCommands } = require("./features");

/**
 * Returns every command module from every package in src/features.
 * Shared with deployCommands.js so both always see the same set.
 */
function loadCommandModules() {
  const modules = [];
  const seen = new Set();

  for (const command of featureCommands()) {
    const file = `features/${command?.data?.name ?? "?"}`;
    if (seen.has(command?.data?.name)) {
      console.log(`${red("[ERROR]")} Two packages define /${command.data.name}; skipping the second.`);
      continue;
    }
    seen.add(command?.data?.name);
    if (command?.data && typeof command.execute === "function") {
      // Every command needs a server, so hide them all from DMs.
      // (setContexts replaces the deprecated setDMPermission.)
      command.data.setContexts(InteractionContextType.Guild);
      modules.push(command);
    } else {
      console.log(
        `${yellow("[WARNING]")} The command at ${file} is missing a required "data" or "execute" property.`
      );
    }
  }
  return modules;
}

/**
 * @description Loads all commands onto client.commands
 * @param {BotClient} client
 */
module.exports = (client) => {
  for (const command of loadCommandModules()) {
    client.commands.set(command.data.name, command);
    console.log(
      `${green("[SUCCESS]")} Loaded command ${magenta(command.data.name)}.`
    );
  }

  if (client.commands.size > 0) {
    console.log(
      `${blue("[INFO]")} ${magenta(client.commands.size)} slash commands loaded.`
    );
  } else {
    console.log(red("[ERROR] No slash commands loaded. UH OH RAGGY!"));
  }
};

module.exports.loadCommandModules = loadCommandModules;
