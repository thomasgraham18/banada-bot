const { green, blue, magenta } = require("chalk");
const icons = require("../../utils/icons");
const schedule = require("../../utils/schedule");

/**
 * Emitted once when the bot has logged in ("ready" was renamed to
 * "clientReady" in discord.js 14.22 and the old name is removed in v15).
 *
 * The rotating presence and the daily command list are driven by
 * utils/schedule.js so the web panel can restart them after a settings change.
 * @param {BotClient} client
 */
module.exports = async (client) => {
  console.log(
    blue("[INFO] ") + magenta(client.user.tag) + green(" is online!")
  );

  // Upload the player button icons as application emojis (first run only).
  await icons.sync(client);

  // Hand the web panel's colour/icon menus to the /autorole reaction engine
  // (also migrates menus posted before the two were merged).
  const synced = require("../../utils/reactionRoles").syncToAutorole();
  if (synced) console.log(`${blue("[INFO]")} Reaction-role menus from the web panel: ${magenta(synced)} synced to /autorole.`);

  schedule.restart(client, { postCommandList: true });
};
