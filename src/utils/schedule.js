/**
 * Recurring jobs that depend on settings: the rotating custom status and the
 * daily command list post. restart() is called on login and again whenever
 * the web panel saves settings, so changes apply without restarting the bot.
 */
const { EmbedBuilder, ActivityType } = require("discord.js");
const { yellow } = require("chalk");

const COMMAND_LIST_INTERVAL_MS = 24 * 60 * 60 * 1000;

const timers = { presence: null, commandList: null };

function setRandomPresence(client) {
  const list = client.settings.activities;
  if (!client.user || !list.length) return;
  client.user.setPresence({
    activities: [
      {
        // Custom statuses show "state"; "name" is required but not displayed.
        name: "Custom Status",
        state: list[Math.floor(Math.random() * list.length)],
        type: ActivityType.Custom,
      },
    ],
    status: "online",
  });
}

/** Builds the command list embed (also used by /help-style previews). */
function commandListEmbed(client) {
  return new EmbedBuilder()
    .setTitle("Commands")
    .setDescription(
      client.commands
        .map((cmd) => `\`${cmd.data.name} - ${cmd.data.description}\``)
        .join("\n")
        .slice(0, 4096)
    )
    .setColor(client.colour);
}

/**
 * Posts the command list in every server that wants it. Each server can set
 * its own channel / turn it off in the panel (Server → Bot settings); the
 * bot-wide channel only applies to the server it belongs to.
 */
async function sendCommandList(client) {
  const { forGuild } = require("./settings");
  const context = require("../core/context");
  for (const guild of client.guilds.cache.values()) {
    const s = forGuild(client, guild.id);
    if (!s.commandListEnabled || !s.commandsChannelId) continue;
    const channel = guild.channels.cache.get(s.commandsChannelId);
    if (!channel) continue; // not this server's channel (or deleted)
    if (!channel.isTextBased()) {
      console.warn(yellow("[WARN]"), `Command list channel #${channel.name} in ${guild.name} is not a text channel.`);
      continue;
    }
    await context.run(guild.id, () => channel.send({ embeds: [commandListEmbed(client)] })).catch((err) =>
      console.warn(yellow("[WARN]"), `Command list in ${guild.name}: ${err.message}`)
    );
  }
}

/**
 * (Re)starts both timers from the current settings.
 * @param {{ postCommandList?: boolean }} [options] post the list right away (startup)
 */
function restart(client, { postCommandList = false } = {}) {
  clearInterval(timers.presence);
  clearInterval(timers.commandList);
  timers.presence = timers.commandList = null;
  if (!client.isReady()) return;

  setRandomPresence(client);
  timers.presence = setInterval(
    () => setRandomPresence(client),
    client.settings.presenceIntervalSec * 1000
  );

  // Always scheduled: servers decide individually whether they want it.
  if (postCommandList) sendCommandList(client);
  timers.commandList = setInterval(() => sendCommandList(client), COMMAND_LIST_INTERVAL_MS);
}

module.exports = { restart, sendCommandList, setRandomPresence };
