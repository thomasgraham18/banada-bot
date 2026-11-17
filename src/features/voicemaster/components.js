/**
 * The interface panel's buttons, user selects and rename modal.
 * Registered through core.components so they keep working after a restart.
 * Custom ids: "vm:<action>" (see service.buildPanel), "vm:renamed" for the modal.
 *
 * Each action runs the same service function as the matching slash command,
 * on the voice channel the clicker is currently in.
 */
const {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { access, components, embeds, UserError } = require("../../core");
const service = require("./service");

/** Panel action -> the /voicemaster subcommand it mirrors (for /access command checks). */
const COMMAND_FOR = {
  lock: "lock", unlock: "unlock", ghost: "ghost", unghost: "unghost", claim: "claim", info: "info",
  limitup: "limit", limitdown: "limit", rename: "name", renamed: "name",
  transfer: "transfer", reject: "reject", disconnect: "reject",
};

/** Runs an action that returns success text, behind an ephemeral defer (Discord calls can be slow). */
async function run(interaction, fn) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await fn();
  const embed = typeof result === "string" ? embeds.success(interaction.client, result) : result;
  return interaction.editReply({ embeds: [embed] });
}

async function handle(interaction, client, [action]) {
  if (!interaction.inGuild()) throw new UserError("This only works in a server.");
  const command = COMMAND_FOR[action];
  if (!command) throw new UserError("This button is no longer supported.");
  const blocked = access.commandBlock(interaction, `voicemaster ${command}`, "voicemaster");
  if (blocked) throw new UserError(blocked);

  const member = interaction.member;
  switch (action) {
    case "lock":
    case "unlock":
    case "ghost":
    case "unghost":
    case "claim":
      return run(interaction, () => service[action](member));
    case "limitup":
      return run(interaction, () => service.stepLimit(member, 1));
    case "limitdown":
      return run(interaction, () => service.stepLimit(member, -1));
    case "info":
      return run(interaction, () => service.infoEmbed(member));

    case "rename": {
      // Check ownership before opening the modal (a modal must be the first response).
      const { channel } = service.currentChannel(member);
      const input = new TextInputBuilder()
        .setCustomId("name")
        .setLabel("New channel name")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true)
        .setValue(channel.name.slice(0, 100));
      return interaction.showModal(
        new ModalBuilder().setCustomId("vm:renamed").setTitle("Rename your channel").addComponents(new ActionRowBuilder().addComponents(input))
      );
    }
    case "renamed":
      return run(interaction, () => service.rename(member, interaction.fields.getTextInputValue("name")));

    case "transfer":
    case "reject":
    case "disconnect":
      return run(interaction, async () => {
        // User selects only carry ids; fetch() returns the cached member when there is one.
        const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
        if (!target) throw new UserError("That member isn't in this server.");
        return service[action](member, target);
      });
  }
  return undefined;
}

module.exports = function registerComponents() {
  components.register("vm", handle);
};
