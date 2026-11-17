/**
 * /config alias add|remove|removeall|view|reset|list (see ../aliases.js for how
 * aliases work on a slash-only bot).
 */
const { ui, UserError } = require("../../../core");
const store = require("../db");
const service = require("../aliases");
const { validateShortcut } = require("../lib");

const handlers = {
  add: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const shortcut = validateShortcut(ctx.options.getString("shortcut", true));
      const target = await service.add(ctx.guild, shortcut, ctx.options.getString("command", true), ctx.user.id);
      await ctx.success(
        `\`/${shortcut}\` now runs \`/${target.path}\` in this server.\n` +
          "It can take a moment to appear in the command list (restart Discord with Ctrl+R if it doesn't). " +
          `Servers can have at most ${service.GUILD_COMMAND_LIMIT} server commands.`
      );
    },
  },

  remove: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const shortcut = validateShortcut(ctx.options.getString("shortcut", true));
      const row = store.aliases.get(ctx.guild.id, shortcut);
      if (!row) throw new UserError(`\`/${shortcut}\` isn't an alias.`);
      await service.remove(ctx.guild, [row]);
      await ctx.success(`Removed the alias \`/${shortcut}\` (it ran \`/${row.command}\`).`);
    },
  },

  removeall: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const command = ctx.options.getString("command", true).trim().replace(/^\//, "").toLowerCase();
      const rows = store.aliases.list(ctx.guild.id).filter((r) => r.command === command || r.command.startsWith(`${command} `));
      if (!rows.length) throw new UserError(`\`/${command}\` has no aliases.`);
      if (!(await ui.confirm(interaction, `Remove all **${rows.length}** alias(es) of \`/${command}\`?`))) return;
      const removed = await service.remove(ctx.guild, rows);
      await ctx.success(`Removed ${removed} alias(es) of \`/${command}\`.`);
    },
  },

  view: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const shortcut = validateShortcut(ctx.options.getString("shortcut", true));
      const row = store.aliases.get(ctx.guild.id, shortcut);
      if (!row) throw new UserError(`\`/${shortcut}\` isn't an alias.`);
      await ctx.info(`\`/${row.shortcut}\` runs \`/${row.command}\`.\nCreated by <@${row.created_by}> ${`<t:${Math.floor(row.created_at / 1000)}:R>`}.`, "Alias");
    },
  },

  reset: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const rows = store.aliases.list(ctx.guild.id);
      if (!rows.length) throw new UserError("This server has no aliases.");
      if (!(await ui.confirm(interaction, `Remove **all ${rows.length}** alias(es) in this server?`))) return;
      const removed = await service.remove(ctx.guild, rows);
      await ctx.success(`Removed ${removed} alias(es).`);
    },
  },

  list: {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const lines = store.aliases.list(ctx.guild.id).map((r) => `\`/${r.shortcut}\` → \`/${r.command}\``);
      await ui.paginate(interaction, ui.listPages(ctx.client, "Aliases", lines, { empty: "No aliases yet. Add one with `/config alias add`." }));
    },
  },
};

const autocomplete = {
  shortcut: (interaction, ctx) => store.aliases.list(ctx.guild.id).map((r) => ({ name: `/${r.shortcut} → /${r.command}`, value: r.shortcut })),
  /** Every runnable command path ("levels rank"), for alias add. */
  target: () => service.allTargets().map((t) => ({ name: `/${t.path}`, value: t.path })),
  /** Commands that have aliases, for removeall. */
  aliased: (interaction, ctx) => [...new Set(store.aliases.list(ctx.guild.id).map((r) => r.command))].map((c) => ({ name: `/${c}`, value: c })),
};

module.exports = { handlers, autocomplete };
