/**
 * Registers the slash commands with Discord. Run after adding, removing or
 * changing a command definition:  npm run deploy
 *
 *   node deployCommands.js            -> global commands (every server)
 *   node deployCommands.js --guild    -> only the GUILD_ID server (instant, for testing)
 *   node deployCommands.js --reset    -> clear the global set AND every server's
 *                                        own set, then register globally
 *   node deployCommands.js --clear    -> clear everything, register nothing
 *
 * Why commands can show up twice: a command registered globally AND to a
 * server (e.g. after testing with --guild) appears twice in that server.
 * --reset fixes that. Server-only /config alias commands are removed too; the
 * bot re-creates them the next time it starts.
 */
const { REST, Routes } = require("discord.js");
const config = require("./config.json");
const { loadCommandModules } = require("./handlers/commands");

const args = new Set(process.argv.slice(2));
const guildOnly = args.has("--guild");
const reset = args.has("--reset");
const clearOnly = args.has("--clear");

const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

/** Every server the bot is in (paged, 200 per request). */
async function botGuilds() {
  const guilds = [];
  let after;
  for (;;) {
    const page = await rest.get(Routes.userGuilds(), {
      query: new URLSearchParams({ limit: "200", ...(after ? { after } : {}) }),
    });
    guilds.push(...page);
    if (page.length < 200) return guilds;
    after = page[page.length - 1].id;
  }
}

/** Removes the global commands and every server-specific command. */
async function clearAll() {
  await rest.put(Routes.applicationCommands(config.CLIENT_ID), { body: [] });
  console.log("Cleared global commands.");

  const guilds = await botGuilds();
  for (const guild of guilds) {
    try {
      const existing = await rest.get(Routes.applicationGuildCommands(config.CLIENT_ID, guild.id));
      if (!existing.length) continue;
      await rest.put(Routes.applicationGuildCommands(config.CLIENT_ID, guild.id), { body: [] });
      console.log(`Cleared ${existing.length} server commands in ${guild.name}.`);
    } catch (err) {
      console.warn(`Could not clear commands in ${guild.name}: ${err.message}`);
    }
  }
}

(async () => {
  try {
    if (reset || clearOnly) await clearAll();
    if (clearOnly) return console.log("Done. No commands are registered now.");

    const commands = loadCommandModules().map((command) => command.data.toJSON());
    const route = guildOnly
      ? Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID)
      : Routes.applicationCommands(config.CLIENT_ID);

    console.log(`Registering ${commands.length} ${guildOnly ? "server (GUILD_ID)" : "global"} commands...`);
    // PUT replaces the whole set, so commands that no longer exist are removed.
    const data = await rest.put(route, { body: commands });
    console.log(`Successfully registered ${data.length} application (/) commands.`);
    if (guildOnly)
      console.log("Note: if these are ALSO registered globally they'll show twice in that server; use --reset when done testing.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
