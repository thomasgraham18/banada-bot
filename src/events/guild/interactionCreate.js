const { MessageFlags } = require("discord.js");
const player = require("../../utils/player");
const components = require("../../core/components");
const access = require("../../core/access");
const guard = require("../../core/guard");
const embeds = require("../../core/embeds");

const AUTOCOMPLETE_COMMANDS = new Set(["play", "playskip", "playtop"]);

// Player button -> the command whose access level it follows.
const PLAYER_BUTTON_COMMANDS = {
  toggle: "pause", previous: "previous", skip: "skip", stop: "stop", queue: "queue",
  shuffle: "shuffle", loop: "loop", autoplay: "autoplay", voldown: "volume", volup: "volume",
};

// Discord drops an autocomplete that is not answered within 3 seconds.
const AUTOCOMPLETE_TIMEOUT_MS = 2500;

// Discord limits: choice name and value are at most 100 characters.
const trim = (text, max = 100) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Suggests YouTube results while the user types in /play, /playskip, /playtop.
 */
async function handleAutocomplete(client, interaction) {
  if (!AUTOCOMPLETE_COMMANDS.has(interaction.commandName)) return;

  const typed = interaction.options.getFocused().trim();
  // Nothing to search for yet, or the user pasted a link.
  if (typed.length < 2 || /^https?:\/\//i.test(typed))
    return interaction.respond([]).catch(() => {});

  try {
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve([]), AUTOCOMPLETE_TIMEOUT_MS)
    );
    const results = await Promise.race([
      client.youtube.search(typed, { limit: 10, safeSearch: true }),
      timeout,
    ]);

    await interaction.respond(
      results
        .filter((song) => song.name && song.url && song.url.length <= 100)
        .slice(0, 25)
        .map((song) => ({ name: trim(song.name), value: song.url }))
    );
  } catch (err) {
    // Expired interactions (user kept typing) are normal; just log the rest.
    if (err?.code !== 10062) console.error("Autocomplete error:", err);
    await interaction.respond([]).catch(() => {});
  }
}

/**
 * Emitted when an interaction is created.
 *
 * Classic commands (src/commands) are deferred HERE, before execute() runs,
 * so they must use interaction.editReply() / followUp() and never reply() or
 * deferReply(). A command module can export `ephemeral: true` to make its
 * response visible only to the user who ran it.
 *
 * Feature commands (src/features, built with core/router.js defineCommand)
 * set `manualDefer` and handle access checks, permissions and deferring
 * themselves.
 *
 * @param {BotClient} client
 * @param {import("discord.js").Interaction} interaction
 */
module.exports = async (client, interaction) => {
  if (!interaction.inGuild()) return;

  if (interaction.isAutocomplete()) {
    // Feature commands (core/router.js) bring their own autocomplete.
    const command = client.commands.get(interaction.commandName);
    if (typeof command?.autocomplete === "function")
      return command.autocomplete(interaction, client);
    return handleAutocomplete(client, interaction);
  }

  // Buttons on the now-playing panel (utils/player.js). Each button obeys the
  // access level of the matching command, so e.g. "/skip for mods" covers the
  // Skip button too.
  if (player.isPlayerButton(interaction)) {
    const action = interaction.customId.slice(3);
    const path = PLAYER_BUTTON_COMMANDS[action] ?? "play";
    const command = client.commands.get(path);
    const denied =
      access.commandBlock(interaction, path, path) ??
      guard.authorizeClassic(interaction.member, path, command?.data.default_member_permissions);
    if (denied)
      return interaction.reply({ embeds: [embeds.error(client, denied)], flags: MessageFlags.Ephemeral }).catch(() => {});
    return player.handleButton(client, interaction);
  }

  // Persistent buttons / selects / modals of feature packages (core/components.js).
  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    await components.dispatch(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    // Registered with Discord but no longer in the code: run `npm run deploy`.
    return interaction
      .reply({
        content: "That command no longer exists.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  // Classic commands (music, help, kick...) get the same /ignore, /access and
  // access-level checks as router commands (the router does its own).
  if (!command.manualDefer) {
    const path = interaction.commandName;
    const denied =
      access.commandBlock(interaction, path, path) ??
      guard.authorizeClassic(interaction.member, path, command.data.default_member_permissions);
    if (denied)
      return interaction
        .reply({ embeds: [embeds.error(client, denied)], flags: MessageFlags.Ephemeral })
        .catch(() => {});
  }

  try {
    // Feature commands defer themselves (some open a modal, which must be the
    // first response); the classic music/help commands are deferred here.
    if (!command.manualDefer)
      await interaction.deferReply(
        command.ephemeral ? { flags: MessageFlags.Ephemeral } : {}
      );

    await command.execute(interaction, client);

    // Commands such as /pause, /volume or /remove change what the player
    // panel shows, so redraw it (does nothing when there is no panel).
    player.refresh(client, interaction.guildId);
  } catch (error) {
    console.error(`Error in /${interaction.commandName}:`, error);

    const content = "There was an error while executing this command!";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      console.error("Failed to send error response:", e);
    }
  }
};
