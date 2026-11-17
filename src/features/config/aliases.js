/**
 * Command aliases for a slash-only bot.
 *
 * Bleed's aliases rename prefix commands. This bot has no text commands, so an
 * alias is a real **guild slash command** /<shortcut> whose options are copied
 * from the target subcommand ("/rank" -> "/levels rank"). When it's used, we
 * rewrite the interaction (command name + options nested back under the
 * group/subcommand) and hand it to the normal interaction handler, so the
 * target's gate, /access checks, deferral and autocomplete all apply as usual.
 *
 * Limits: Discord allows 100 guild slash commands per server. `npm run deploy
 * -- --guild` replaces every guild command of the dev guild, wiping aliases
 * there; they are re-created on the next start (resync()).
 *
 * Routing: events/guild/interactionCreate.js looks commands up with
 * client.commands.get(name). Alias names are per guild, so instead of adding
 * them to client.commands (where /help and the web panel would list them)
 * we wrap get() to fall back to one shared alias proxy. See the report:
 * a core hook for "unknown command" would be cleaner.
 */
const { CommandInteractionOptionResolver, MessageFlags, Routes } = require("discord.js");
const { UserError } = require("../../core");
const store = require("./db");
const { runnablePaths, aliasCommandJson, nestOptions } = require("./lib");

const GUILD_COMMAND_LIMIT = 100;

let clientRef = null;
let originalGet = null;
/** Shortcut names used in any guild (only these can reach the proxy). */
const shortcuts = new Set();

const refreshShortcuts = () => {
  shortcuts.clear();
  for (const s of store.aliases.allShortcuts()) shortcuts.add(s);
};

/** A real (non-alias) top-level command by name. */
const realCommand = (name) => (originalGet ? originalGet(name) : clientRef?.commands?.get(name));

/** Every runnable path of every real command: [{ path, group, sub, options, description }]. */
function allTargets() {
  const out = [];
  if (!clientRef?.commands) return out;
  for (const command of clientRef.commands.values()) {
    if (!command?.data?.toJSON) continue;
    out.push(...runnablePaths(command.data.toJSON()));
  }
  return out;
}

/** Resolves "levels rank" (or "/levels rank") to its target, or throws. */
function resolveTarget(text) {
  const path = String(text ?? "").trim().replace(/^\//, "").replace(/\s+/g, " ").toLowerCase();
  const command = realCommand(path.split(" ")[0]);
  const target = command?.data?.toJSON ? runnablePaths(command.data.toJSON()).find((t) => t.path === path) : null;
  if (!target) throw new UserError(`\`/${path}\` isn't a command. Pick one from the suggestions, e.g. \`levels rank\`.`);
  return { command, target };
}

// ---------------------------------------------------------------- routing

/** Rewrites an alias interaction in place to look like the target command. */
function rewrite(interaction, target) {
  const top = target.path.split(" ")[0];
  interaction.commandName = top;
  interaction.options = new CommandInteractionOptionResolver(
    interaction.client,
    nestOptions(interaction.options.data, target.group, target.sub),
    interaction.options.resolved ?? undefined
  );
}

/** Looks the alias up for this guild and rewrites the interaction. Returns false if it's gone. */
function prepare(interaction) {
  const row = interaction.guildId ? store.aliases.get(interaction.guildId, interaction.commandName) : null;
  if (!row) return false;
  try {
    rewrite(interaction, resolveTarget(row.command).target);
    return true;
  } catch {
    return false;
  }
}

/** Re-dispatches through the bot's normal interaction handler (deferral, player refresh...). */
const redispatch = (interaction) => require("../../events/guild/interactionCreate")(interaction.client, interaction);

const proxy = {
  manualDefer: true, // the real command (re-dispatched) decides how to defer
  async execute(interaction) {
    if (!prepare(interaction))
      return interaction
        .reply({ content: "This alias no longer points at a command. Ask an admin to check `/config alias list`.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    return redispatch(interaction);
  },
  async autocomplete(interaction) {
    if (!prepare(interaction)) return interaction.respond([]).catch(() => {});
    return redispatch(interaction);
  },
};

/** Called from setup(): wraps client.commands.get() so alias names reach the proxy. */
function install(client) {
  clientRef = client;
  refreshShortcuts();
  if (!client.commands || originalGet) return;
  originalGet = client.commands.get.bind(client.commands);
  client.commands.get = (name) => originalGet(name) ?? (shortcuts.has(name) ? proxy : undefined);
}

// ---------------------------------------------------------------- Discord guild commands

const appId = (client) => client.application?.id ?? client.user?.id;

async function createGuildCommand(guild, shortcut, target) {
  const client = guild.client;
  const body = aliasCommandJson(shortcut, target);
  return client.rest.post(Routes.applicationGuildCommands(appId(client), guild.id), { body });
}

async function deleteGuildCommand(guild, commandId) {
  if (!commandId) return;
  await guild.client.rest.delete(Routes.applicationGuildCommand(appId(guild.client), guild.id, commandId)).catch((err) => {
    if (err?.code !== 10063) throw err; // "Unknown application command" = already gone
  });
}

/** /config alias add */
async function add(guild, shortcut, commandText, userId) {
  if (realCommand(shortcut)) throw new UserError(`\`/${shortcut}\` is already a bot command.`);
  if (store.aliases.get(guild.id, shortcut)) throw new UserError(`\`/${shortcut}\` is already an alias. Remove it first.`);
  const { target } = resolveTarget(commandText);
  if (target.path.split(" ")[0] === "config" && target.group === "alias") throw new UserError("You can't alias the alias commands.");

  const existing = await guild.client.rest.get(Routes.applicationGuildCommands(appId(guild.client), guild.id));
  if (existing.some((c) => c.name === shortcut && c.type === 1)) throw new UserError(`This server already has a \`/${shortcut}\` command.`);
  if (existing.filter((c) => c.type === 1).length >= GUILD_COMMAND_LIMIT)
    throw new UserError(`Discord allows ${GUILD_COMMAND_LIMIT} server slash commands, and this server has reached it. Remove some aliases first.`);

  const created = await createGuildCommand(guild, shortcut, target);
  store.aliases.add(guild.id, shortcut, target.path, created.id, userId);
  shortcuts.add(shortcut);
  return target;
}

/** Removes aliases (rows + guild commands). Returns how many were removed. */
async function remove(guild, rows) {
  let removed = 0;
  for (const row of rows) {
    await deleteGuildCommand(guild, row.discord_command_id);
    if (store.aliases.remove(guild.id, row.shortcut)) removed++;
  }
  refreshShortcuts();
  return removed;
}

/**
 * On start: re-create alias commands that are missing on Discord (for example
 * after `npm run deploy -- --guild` replaced the dev guild's commands).
 */
async function resync(client) {
  for (const guildId of store.aliases.guilds()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      const existing = await client.rest.get(Routes.applicationGuildCommands(appId(client), guildId));
      const byName = new Map(existing.map((c) => [c.name, c]));
      for (const row of store.aliases.list(guildId)) {
        const found = byName.get(row.shortcut);
        if (found) {
          if (found.id !== row.discord_command_id) store.aliases.setDiscordId(guildId, row.shortcut, found.id);
          continue;
        }
        let target;
        try {
          target = resolveTarget(row.command).target;
        } catch {
          continue; // its command was removed from the bot; leave the row for an admin to see
        }
        const created = await createGuildCommand(guild, row.shortcut, target);
        store.aliases.setDiscordId(guildId, row.shortcut, created.id);
      }
    } catch (err) {
      console.warn(`[config:aliases] resync failed for guild ${guildId}: ${err.message}`);
    }
  }
}

module.exports = { install, add, remove, resync, resolveTarget, allTargets, proxy, GUILD_COMMAND_LIMIT };
