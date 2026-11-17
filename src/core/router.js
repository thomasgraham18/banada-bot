/**
 * defineCommand(): one top-level slash command with its handlers.
 *
 *   module.exports = defineCommand({
 *     data: new SlashCommandBuilder().setName("starboard").setDescription("…")
 *       .addSubcommand((s) => s.setName("set").setDescription("…")…),
 *     module: "starboard",                  // for /access module (default: the command name)
 *     handlers: {
 *       "set":          { gate: "Manage Channels", run: async (interaction, ctx) => { … } },
 *       "emoji add":    { gate: "Manage Channels", defer: "ephemeral", run },
 *       "message set":  { gate: "Manage Guild", defer: false, run },   // opens a modal
 *     },
 *     autocomplete: {
 *       "emoji remove": (interaction, ctx) => [{ name: "⭐", value: "⭐" }],   // or plain strings
 *     },
 *   });
 *
 * Handler keys are "subcommand" or "group subcommand" ("" for a command with
 * no subcommands). For every invocation the router:
 *   1. checks /ignore and /access (core/access.js)
 *   2. checks the handler's gate (core/guard.js)
 *   3. defers: true / "public" (default), "ephemeral", or false (modals, or
 *      handlers that reply within 3 s themselves)
 *   4. runs the handler with ctx, catching errors: a UserError becomes an
 *      ephemeral error embed, anything else is logged.
 *
 * ctx = { client, guild, member, user, channel, options, path,
 *         reply(payload), success(text), error(text), info(text, title),
 *         promptScript({ title, current }) }
 * ctx.reply* go to the modal submission once promptScript() has been used.
 */
const { MessageFlags, PermissionFlagsBits, ApplicationCommandOptionType: T } = require("discord.js");
const access = require("./access");
const guard = require("./guard");
const embeds = require("./embeds");
const errors = require("./errors");
const ui = require("./ui");

/** Every subcommand path of a command JSON ("" when it has none). */
function commandPaths(json) {
  const paths = [];
  for (const opt of json.options ?? []) {
    if (opt.type === T.SubcommandGroup) for (const sub of opt.options ?? []) paths.push(`${opt.name} ${sub.name}`);
    else if (opt.type === T.Subcommand) paths.push(opt.name);
  }
  return paths.length ? paths : [""];
}

/** Checks Discord's tree limits and that handlers match subcommands. Returns problems. */
function validate(json, handlers = {}) {
  const problems = [];
  const top = json.options ?? [];
  const subs = top.filter((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup);
  if (subs.length > 25) problems.push(`/${json.name} has ${subs.length} subcommands/groups (max 25)`);
  const checkOptions = (where, options = []) => {
    if (options.length > 25) problems.push(`${where} has ${options.length} options (max 25)`);
    let seenOptional = false;
    for (const o of options) {
      if (o.required && seenOptional) problems.push(`${where}: required option "${o.name}" comes after an optional one`);
      if (!o.required) seenOptional = true;
      if (o.choices?.length > 25) problems.push(`${where} ${o.name}: more than 25 choices`);
    }
  };
  for (const opt of top) {
    if (opt.type === T.SubcommandGroup) {
      if ((opt.options ?? []).length > 25) problems.push(`/${json.name} ${opt.name} has more than 25 subcommands`);
      for (const sub of opt.options ?? []) checkOptions(`/${json.name} ${opt.name} ${sub.name}`, sub.options);
    } else if (opt.type === T.Subcommand) checkOptions(`/${json.name} ${opt.name}`, opt.options);
  }
  if (!subs.length) checkOptions(`/${json.name}`, top);

  const paths = commandPaths(json);
  for (const p of paths) if (!handlers[p]) problems.push(`/${json.name} ${p}: no handler`);
  for (const key of Object.keys(handlers)) if (!paths.includes(key)) problems.push(`/${json.name}: handler "${key}" matches no subcommand`);
  return problems;
}

const pathOf = (interaction) =>
  [interaction.options.getSubcommandGroup(false), interaction.options.getSubcommand(false)].filter(Boolean).join(" ");

function makeContext(interaction) {
  const ctx = {
    client: interaction.client,
    guild: interaction.guild,
    member: interaction.member,
    user: interaction.user,
    channel: interaction.channel,
    options: interaction.options,
    path: pathOf(interaction),
    /** Where replies go: the interaction, or the modal submission after promptScript(). */
    target: interaction,
    reply: (payload) => ui.respond(ctx.target, payload),
    success: (text, title) => ui.respond(ctx.target, { embeds: [embeds.success(interaction.client, text, title)] }),
    error: (text, title) => ui.respond(ctx.target, { embeds: [embeds.error(interaction.client, text, title)] }),
    info: (text, title) => ui.respond(ctx.target, { embeds: [embeds.info(interaction.client, text, title)] }),
    async promptScript(options) {
      const result = await ui.promptScript(interaction, options);
      if (result) ctx.target = result.submit;
      return result;
    },
  };
  return ctx;
}

async function replyError(target, err, label) {
  const text = errors.describe(err);
  if (!text) console.error(`[/${label}] failed:`, err);
  const embed = embeds.error(target.client, text ?? "Something went wrong running that command. It has been logged.");
  try {
    if (target.deferred && !target.replied) {
      // A public "thinking…" message: replace it with an ephemeral error.
      const ephemeral = target.ephemeral ?? false;
      if (ephemeral) await target.editReply({ embeds: [embed], components: [] });
      else {
        await target.deleteReply().catch(() => {});
        await target.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    } else if (target.replied) await target.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    else await target.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch {
    /* interaction expired */
  }
}

/** The Discord permission that "stands for" each access level in the "/" menu. */
const LEVEL_VISIBILITY = {
  1: PermissionFlagsBits.ManageMessages, // mod
  2: PermissionFlagsBits.ManageGuild, // admin
  3: PermissionFlagsBits.Administrator, // owner
};

/** Visibility bits for a command from its handlers' gates (null = everyone). */
function visibilityFor(gates) {
  const lowest = Math.min(...gates.map((g) => guard.levels.gateLevel(g, guard.PERMISSION_GATES)));
  return LEVEL_VISIBILITY[lowest] ?? null;
}

function defineCommand({ data, module, handlers, autocomplete = {}, gate: defaultGate, visibility }) {
  const name = data.name;
  const normalised = {};
  for (const [key, h] of Object.entries(handlers)) normalised[key] = typeof h === "function" ? { run: h } : h;

  // Hide staff commands from regular members' "/" menu (Discord's
  // default_member_permissions). Who may RUN a command is decided separately by
  // guard.authorize (access levels + gates); this only controls visibility.
  // A command is hidden when none of its subcommands is for members; it's then
  // shown to the permission that stands for its lowest level (LEVEL_VISIBILITY).
  // Panel-assigned mods without that permission can still run it, but need it
  // allowed in Server Settings → Integrations to see it (Discord limitation).
  // `visibility: "public"` keeps a command visible; a bigint sets it directly.
  if (data.default_member_permissions === undefined && visibility !== "public") {
    const bits = typeof visibility === "bigint" ? visibility : visibilityFor(Object.values(normalised).map((h) => h.gate ?? defaultGate));
    if (bits != null) data.setDefaultMemberPermissions(bits);
  }

  return {
    data,
    module: module ?? name,
    handlers: normalised,
    // Tells events/guild/interactionCreate.js not to auto-defer: the router does it.
    manualDefer: true,
    validate: () => validate(data.toJSON(), normalised),

    async execute(interaction) {
      const path = pathOf(interaction);
      const handler = normalised[path];
      const full = `${name}${path ? ` ${path}` : ""}`;
      const ctx = makeContext(interaction);
      try {
        if (!handler) throw new errors.UserError("This subcommand isn't implemented yet.");

        const blocked = access.commandBlock(interaction, full, module ?? name);
        if (blocked) throw new errors.UserError(blocked);
        // Access level (web panel → Permissions) + the subcommand's permission gate.
        const denied = guard.authorize(interaction.member, full, handler.gate ?? defaultGate);
        if (denied) throw new errors.UserError(denied);

        const defer = handler.defer ?? true;
        if (defer === "ephemeral") await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        else if (defer) await interaction.deferReply();

        await handler.run(interaction, ctx);
      } catch (err) {
        await replyError(ctx.target, err, full);
      }
    },

    async autocomplete(interaction) {
      const path = pathOf(interaction);
      const provider = typeof autocomplete === "function" ? autocomplete : autocomplete[path];
      if (!provider) return interaction.respond([]).catch(() => {});
      // Suggestions list stored data (filtered words, webhooks…): only show them
      // to members who could run the subcommand.
      const handler = normalised[path];
      const full = `${name}${path ? ` ${path}` : ""}`;
      if (
        !handler ||
        access.commandBlock(interaction, full, module ?? name) ||
        guard.authorize(interaction.member, full, handler.gate ?? defaultGate)
      )
        return interaction.respond([]).catch(() => {});
      try {
        const focused = interaction.options.getFocused(true);
        const typed = String(focused.value ?? "").toLowerCase();
        const raw = await provider(interaction, { ...makeContext(interaction), focused });
        const choices = (raw ?? [])
          .map((c) => (typeof c === "object" ? c : { name: String(c), value: String(c) }))
          .filter((c) => !typed || c.name.toLowerCase().includes(typed) || String(c.value).toLowerCase().includes(typed))
          .slice(0, 25)
          .map((c) => ({ name: String(c.name).slice(0, 100), value: typeof c.value === "string" ? c.value.slice(0, 100) : c.value }));
        await interaction.respond(choices);
      } catch (err) {
        if (err?.code !== 10062) console.error(`[autocomplete /${name} ${path}]`, err);
        await interaction.respond([]).catch(() => {});
      }
    },
  };
}

module.exports = { defineCommand, validate, commandPaths, pathOf };
