/**
 * /filter: chat filters, AutoMod mirroring and the points ladder (WP2).
 *
 * Tree (26 subcommands):
 *   exempt add|remove|list · word add|remove|list|allow|unallow|regex|reset|migrate
 *   url allow|disallow|list · points limit|setup|view|member|clear · names config|cleanup
 *   setup · set · clear · config · snipe
 *
 * Word-related replies are ephemeral so filtered words are never echoed
 * into public channels.
 */
const {
  SlashCommandBuilder,
  ChannelType,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const { defineCommand, ui, parse, guard, config, ensure, UserError } = require("../../../core");
const store = require("../db");
const automod = require("../automod");
const service = require("../service");
const { describeSetting, regexProblem, parseHost, normalise } = require("../match");
const points = require("../points");
const {
  TYPES, THRESHOLDS, DESCRIPTIONS, PUNISHMENTS, TIMED, SNIPE_TYPES, AUTOMOD_TYPES, LIMITS,
  POINT_DECAY_MS, FALLBACK_NAME,
} = require("../constants");

const MANAGE = "Manage Channels";
const choices = (list) => list.map((v) => ({ name: v, value: v }));
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice];
const MESSAGE_TYPES = TYPES.filter((t) => t !== "names");

// ------------------------------------------------------------------ helpers

const typeOption = (o, list = TYPES) => o.setName("type").setDescription("Which filter").setRequired(true).addChoices(...choices(list));

/** "on · 70% capital letters · timeout 10m" */
function formatSetting(type, s) {
  const parts = [s.enabled ? "**on**" : "off"];
  if (THRESHOLDS[type] && s.threshold) parts.push(`${s.threshold} ${THRESHOLDS[type].unit}`);
  if (type === "names") parts.push("rename");
  else parts.push(`${s.punishment}${s.durationMs && TIMED.has(s.punishment) ? ` ${parse.formatDuration(s.durationMs)}` : ""}`);
  return parts.join(" · ");
}

/** Validates a threshold for a type; returns it (or null when not given). */
function checkThreshold(type, value) {
  if (value === null || value === undefined) return null;
  const spec = THRESHOLDS[type];
  ensure(spec, `The **${type}** filter doesn't use a threshold.`);
  ensure(value >= spec.min && value <= spec.max, `The **${type}** threshold is ${spec.unit} and must be ${spec.min}-${spec.max}.`);
  return value;
}

/** Parses a punishment duration; timeouts are capped at Discord's 28 days. */
const parsePunishDuration = (text, punishment) =>
  text ? parse.duration(text, { min: 60e3, max: punishment === "timeout" ? 28 * 86400e3 : undefined }) : null;

/** Re-syncs AutoMod for `type` when it is a mirrored kind; returns a status line or "". */
async function syncLine(guild, type) {
  if (!AUTOMOD_TYPES.includes(type)) return "";
  const line = await automod.sync(guild, type);
  return line ? `\n-# ${line}` : "";
}

/** Shows a modal and waits for its submission (deferred, public). Null if closed. */
async function askModal(interaction, modal, time = 600_000) {
  await interaction.showModal(modal);
  const submit = await interaction
    .awaitModalSubmit({ time, filter: (m) => m.customId === modal.data.custom_id && m.user.id === interaction.user.id })
    .catch(() => null);
  if (submit) await submit.deferReply();
  return submit;
}

const cleanWord = (text) => String(text).trim().toLowerCase().replace(/\s+/g, " ");

function validateWord(word) {
  ensure(word.length >= 1 && word.length <= LIMITS.wordLength, `Words must be 1-${LIMITS.wordLength} characters.`);
  ensure(!/^\*+$/.test(word), "A word can't be only wildcards.");
  ensure(!word.slice(1, -1).includes("*"), "Wildcards (`*`) only work at the start or end of a word, like AutoMod.");
  ensure(normalise(word.replace(/\*/g, "")).trim(), "That word is empty once accents and invisible characters are removed.");
}

// Autocomplete skips the router's gate, so check it here: filtered words must
// not be shown to members who can't manage the filter.
const wordAutocomplete = (kind) => (interaction) =>
  guard.check(interaction.member, MANAGE) ? [] : store.listWords(interaction.guildId, kind);

/** Builds the /filter setup and /filter points setup modals (exported for tests). */
function setupModal(customId, type, current) {
  const enabled = new StringSelectMenuBuilder().setCustomId("enabled").addOptions(
    { label: "Enabled", value: "on", default: current.enabled },
    { label: "Disabled", value: "off", default: !current.enabled }
  );
  const punishment = new StringSelectMenuBuilder().setCustomId("punishment").addOptions(
    PUNISHMENTS.map((p) => ({ label: p, value: p, default: p === current.punishment }))
  );
  const modal = new ModalBuilder().setCustomId(customId).setTitle(`Filter: ${type}`);
  const labels = [new LabelBuilder().setLabel("Status").setStringSelectMenuComponent(enabled)];
  if (type !== "names") labels.push(new LabelBuilder().setLabel("Punishment").setStringSelectMenuComponent(punishment));
  if (THRESHOLDS[type])
    labels.push(
      new LabelBuilder()
        .setLabel("Threshold")
        .setDescription(`${THRESHOLDS[type].unit} (${THRESHOLDS[type].min}-${THRESHOLDS[type].max})`)
        .setTextInputComponent(
          new TextInputBuilder().setCustomId("threshold").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setValue(String(current.threshold ?? ""))
        )
    );
  if (type !== "names")
    labels.push(
      new LabelBuilder()
        .setLabel("Duration")
        .setDescription("For timeout / mute / jail / ban, e.g. 10m, 1h, 2d. Blank = default.")
        .setTextInputComponent(
          new TextInputBuilder().setCustomId("duration").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)
            .setValue(current.durationMs ? parse.formatDuration(current.durationMs).replace(/\s+/g, "") : "")
        )
    );
  return modal.addLabelComponents(...labels);
}

function pointsModal(customId, values, ladder) {
  return new ModalBuilder().setCustomId(customId).setTitle("Filter points").addLabelComponents(
    new LabelBuilder()
      .setLabel("Points per filter")
      .setDescription("filter=points, comma separated. Unlisted filters give 1 point.")
      .setTextInputComponent(
        new TextInputBuilder().setCustomId("values").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
          .setPlaceholder("words=3, invites=2, spam=1").setValue(points.formatPointValues(values))
      ),
    new LabelBuilder()
      .setLabel("Escalation ladder")
      .setDescription("One step per line: <points> <punishment> [duration]")
      .setTextInputComponent(
        new TextInputBuilder().setCustomId("ladder").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
          .setPlaceholder("3 timeout 10m\n6 jail 1d\n10 ban").setValue(points.formatLadder(ladder))
      )
  );
}

// ------------------------------------------------------------------ handlers

const handlers = {
  // ---------------- exempt
  "exempt add": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const type = ctx.options.getString("type", true);
      const role = ctx.options.getRole("role", true);
      ensure(role.id !== ctx.guild.id, "Exempting @everyone would switch the filter off; use `/filter set` instead.");
      const { changes } = store.setExempt(ctx.guild.id, type, role.id, true);
      ensure(changes, `${role} is already exempt from the **${type}** filter.`);
      await ctx.success(`${role} is now exempt from the **${type}** filter.${await syncLine(ctx.guild, type)}`);
    },
  },
  "exempt remove": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const type = ctx.options.getString("type", true);
      const role = ctx.options.getRole("role", true);
      const { changes } = store.setExempt(ctx.guild.id, type, role.id, false);
      ensure(changes, `${role} isn't exempt from the **${type}** filter.`);
      await ctx.success(`${role} is no longer exempt from the **${type}** filter.${await syncLine(ctx.guild, type)}`);
    },
  },
  "exempt list": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const type = ctx.options.getString("type", true);
      const roles = [...(store.rules.get(ctx.guild.id).exempt.get(type) ?? [])];
      const lines = roles.map((id) => `<@&${id}> (\`${id}\`)`);
      await ui.paginate(interaction, ui.listPages(ctx.client, `Roles exempt from ${type}`, lines, {
        empty: "No roles are exempt. Owners, administrators and staff are always exempt.",
        footer: "Owner, admins and staff are always exempt",
      }));
    },
  },

  // ---------------- word
  "word add": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const word = cleanWord(ctx.options.getString("word", true));
      validateWord(word);
      ensure(store.countWords(ctx.guild.id, "block") < LIMITS.words, `You can filter at most ${LIMITS.words} words (AutoMod's limit).`);
      const { changes } = store.addWord(ctx.guild.id, "block", word, ctx.user.id);
      ensure(changes, `||${word}|| is already filtered.`);
      const off = !describeSetting(store.rules.get(ctx.guild.id), "words").enabled;
      await ctx.success(
        `Added ||${word}|| to the word filter.${off ? "\n-# The words filter is off: turn it on with `/filter set words true`." : ""}${await syncLine(ctx.guild, "words")}`
      );
    },
  },
  "word remove": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const word = cleanWord(ctx.options.getString("word", true));
      const { changes } = store.removeWord(ctx.guild.id, "block", word);
      ensure(changes, `||${word}|| isn't in the word filter.`);
      await ctx.success(`Removed ||${word}|| from the word filter.${await syncLine(ctx.guild, "words")}`);
    },
  },
  "word list": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const g = ctx.guild.id;
      const lines = [
        ...store.listWords(g, "block").map((w) => `🚫 \`${w}\``),
        ...store.listWords(g, "allow").map((w) => `✅ \`${w}\``),
        ...store.listWords(g, "regex").map((w) => `🔣 \`${w.replace(/`/g, "ˋ")}\``),
      ];
      await ui.paginate(interaction, ui.listPages(ctx.client, "Word filter", lines, {
        perPage: 20,
        empty: "No words are filtered yet. Add some with `/filter word add`.",
        footer: "🚫 blocked • ✅ allowed • 🔣 regex",
      }));
    },
  },
  "word allow": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const word = cleanWord(ctx.options.getString("word", true));
      ensure(word.length <= LIMITS.wordLength && !word.includes("*"), `Allowed words are plain words up to ${LIMITS.wordLength} characters (no wildcards).`);
      ensure(store.countWords(ctx.guild.id, "allow") < LIMITS.allow, `You can allow at most ${LIMITS.allow} words (AutoMod's limit).`);
      const { changes } = store.addWord(ctx.guild.id, "allow", word, ctx.user.id);
      ensure(changes, `\`${word}\` is already allowed.`);
      await ctx.success(`\`${word}\` is now allowed through the word filter.${await syncLine(ctx.guild, "words")}`);
    },
  },
  "word unallow": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const word = cleanWord(ctx.options.getString("word", true));
      const { changes } = store.removeWord(ctx.guild.id, "allow", word);
      ensure(changes, `\`${word}\` isn't on the allow list.`);
      await ctx.success(`\`${word}\` is no longer allowed.${await syncLine(ctx.guild, "words")}`);
    },
  },
  "word regex": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const pattern = ctx.options.getString("pattern", true).trim();
      const add = ctx.options.getBoolean("setting", true);
      if (add) {
        const problem = regexProblem(pattern);
        if (problem) throw new UserError(problem);
        ensure(store.countWords(ctx.guild.id, "regex") < LIMITS.regex, `You can have at most ${LIMITS.regex} regex patterns (AutoMod's limit).`);
        const { changes } = store.addWord(ctx.guild.id, "regex", pattern, ctx.user.id);
        ensure(changes, "That pattern is already in the filter.");
        await ctx.success(`Added the regex pattern to the word filter.${await syncLine(ctx.guild, "words")}`);
      } else {
        const { changes } = store.removeWord(ctx.guild.id, "regex", pattern);
        ensure(changes, "That pattern isn't in the filter.");
        await ctx.success(`Removed the regex pattern.${await syncLine(ctx.guild, "words")}`);
      }
    },
  },
  "word reset": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      const count = store.countWords(ctx.guild.id, "block");
      ensure(count, "The word list is already empty.");
      if (!(await ui.confirm(interaction, `Delete all **${count}** filtered words? Allowed words and regex patterns are kept.`))) return;
      store.resetWords(ctx.guild.id);
      await ctx.success(`Cleared **${count}** filtered words.${await syncLine(ctx.guild, "words")}`);
    },
  },
  "word migrate": {
    gate: MANAGE,
    defer: "ephemeral",
    async run(interaction, ctx) {
      guard.assertBotPermissions(ctx.guild, [PermissionFlagsBits.ManageGuild]);
      const compiled = store.rules.get(ctx.guild.id);
      const { block, regex, allow } = compiled.words.lists;
      ensure(block.length || regex.length, "There are no words or patterns to migrate. Add some with `/filter word add`.");
      const setting = describeSetting(compiled, "words");
      ensure(setting.enabled, "Turn the words filter on first: `/filter set words true`.");
      ensure(
        ["delete", "timeout"].includes(setting.punishment),
        `AutoMod can only block or time out, but the words filter's punishment is **${setting.punishment}**. ` +
          "Set it to `delete` or `timeout` (`/filter set words true punishment:delete`) to migrate, or keep the bot-side filter."
      );
      const line = await automod.sync(ctx.guild, "words");
      ensure(store.getAutomodRule(ctx.guild.id, "words"), line ?? "AutoMod didn't accept the rule.");
      await ctx.success(
        `Copied **${Math.min(block.length, 1000)}** words, **${regex.length}** patterns and **${allow.length}** allowed words into Discord AutoMod.\n` +
          "From now on, word changes are kept in sync automatically (Server Settings → AutoMod)." +
          `\n-# ${line}`
      );
    },
  },

  // ---------------- url
  "url allow": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const host = parseHost(ctx.options.getString("url", true));
      ensure(host, "That doesn't look like a website. Try `example.com` or `https://example.com`.");
      ensure(store.listUrls(ctx.guild.id).length < LIMITS.urls, `You can whitelist at most ${LIMITS.urls} sites.`);
      const { changes } = store.setUrl(ctx.guild.id, host, true);
      ensure(changes, `\`${host}\` is already whitelisted.`);
      await ctx.success(`\`${host}\` (and its subdomains) can now be linked past the links filter.`);
    },
  },
  "url disallow": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const input = ctx.options.getString("url", true);
      const host = parseHost(input) ?? input.trim().toLowerCase();
      const { changes } = store.setUrl(ctx.guild.id, host, false);
      ensure(changes, `\`${host}\` isn't whitelisted.`);
      await ctx.success(`Removed \`${host}\` from the links whitelist.`);
    },
  },
  "url list": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const lines = store.listUrls(ctx.guild.id).map((h) => `\`${h}\``);
      await ui.paginate(interaction, ui.listPages(ctx.client, "Links filter whitelist", lines, {
        perPage: 20,
        empty: "No sites are whitelisted: the links filter removes every link.",
        footer: "Subdomains are included",
      }));
    },
  },

  // ---------------- points
  "points limit": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const limit = ctx.options.getInteger("points", true);
      store.setPointsLimit(ctx.guild.id, limit || null);
      await ctx.success(limit ? `Members can now build up at most **${limit}** filter points.` : "Removed the points limit.");
    },
  },
  "points setup": {
    gate: MANAGE,
    defer: false,
    async run(interaction, ctx) {
      const compiled = store.rules.get(ctx.guild.id);
      const submit = await askModal(interaction, pointsModal(`flt:points:${interaction.id}`, compiled.points, compiled.ladder));
      if (!submit) return;
      ctx.target = submit;
      const values = points.parsePointValues(submit.fields.getTextInputValue("values"));
      const ladder = points.parseLadder(submit.fields.getTextInputValue("ladder"));
      store.savePointsSetup(ctx.guild.id, values, ladder);
      const unused = !MESSAGE_TYPES.some((t) => describeSetting(store.rules.get(ctx.guild.id), t).punishment === "points");
      await ctx.success(
        `Saved **${values.size}** point values and a **${ladder.length}**-step ladder.` +
          (unused ? "\n-# No filter uses the `points` punishment yet: `/filter set <type> true punishment:points`." : "")
      );
    },
  },
  "points view": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const compiled = store.rules.get(ctx.guild.id);
      const using = MESSAGE_TYPES.filter((t) => describeSetting(compiled, t).punishment === "points");
      const values = MESSAGE_TYPES.map((t) => `\`${t}\` ${compiled.points.get(t) ?? 1}${using.includes(t) ? " ✅" : ""}`).join(" · ");
      const ladder = compiled.ladder.length
        ? compiled.ladder.map((s) => `**${s.points}** pts → ${s.punishment}${s.durationMs ? ` (${parse.formatDuration(s.durationMs)})` : ""}`).join("\n")
        : "No ladder yet: set one with `/filter points setup`.";
      await ctx.info(
        `**Points per filter** (✅ = filter set to \`points\`)\n${values}\n\n**Ladder**\n${ladder}\n\n` +
          `**Limit:** ${compiled.limit ?? "none"}\n` +
          `-# Points decay by 1 every ${parse.formatDuration(POINT_DECAY_MS)} without a new violation.`,
        "Filter points"
      );
    },
  },
  "points member": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const user = ctx.options.getUser("member", true);
      const total = service.getPoints(ctx.guild.id, user.id);
      const next = store.rules.get(ctx.guild.id).ladder.find((s) => s.points > total);
      await ctx.info(
        `${user} has **${total}** filter point${total === 1 ? "" : "s"}.` +
          (next ? `\nNext step: **${next.punishment}** at ${next.points} points.` : ""),
        "Filter points"
      );
    },
  },
  "points clear": {
    gate: MANAGE,
    async run(interaction, ctx) {
      const user = ctx.options.getUser("member", true);
      const amount = ctx.options.getInteger("amount");
      const current = service.getPoints(ctx.guild.id, user.id);
      ensure(current, `${user} has no filter points.`);
      if (!(await ui.confirm(interaction, `Remove ${amount ? `**${Math.min(amount, current)}**` : "**all**"} of ${user}'s ${current} filter points?`, { danger: false })))
        return;
      const { after } = service.removePoints(ctx.guild.id, user.id, amount);
      await ctx.success(`${user} now has **${after}** filter point${after === 1 ? "" : "s"}.`);
    },
  },

  // ---------------- names
  "names config": {
    gate: "Manage Nicknames",
    async run(interaction, ctx) {
      const compiled = store.rules.get(ctx.guild.id);
      const s = describeSetting(compiled, "names");
      const exempt = [...(compiled.exempt.get("names") ?? [])].map((id) => `<@&${id}>`).join(", ") || "none";
      const autonick = config.get(ctx.guild.id, config.KEYS.AUTONICK);
      await ctx.info(
        `**Status:** ${s.enabled ? "on" : "off"} (\`/filter set names\`)\n` +
          `**Checks:** words filter (${compiled.words.lists.block.length} words, ${compiled.words.lists.regex.length} patterns) and zalgo (${s.threshold}+ stacked accents)\n` +
          `**Replacement name:** ${typeof autonick === "string" && autonick ? autonick : FALLBACK_NAME} when a filtered word is found; zalgo is stripped\n` +
          `**Exempt roles:** ${exempt}\n-# Owner, administrators, staff and members above my role are skipped.`,
        "Name filter"
      );
    },
  },
  "names cleanup": {
    gate: "Manage Nicknames",
    async run(interaction, ctx) {
      guard.assertBotPermissions(ctx.guild, [PermissionFlagsBits.ManageNicknames]);
      ensure(store.rules.get(ctx.guild.id).namesActive, "The names filter is off. Turn it on with `/filter set names true`.");
      if (!(await ui.confirm(interaction, "Check every member's name now and rename the ones that break the filter?", { danger: false }))) return;
      const members = await ctx.guild.members.fetch();
      let checked = 0;
      let renamed = 0;
      for (const member of members.values()) {
        if (!service.nameProblem(member)) continue;
        checked++;
        // Sequential on purpose: discord.js queues requests to respect the rate limit.
        if (await service.enforceName(member)) renamed++;
      }
      await ctx.success(
        `Scanned **${members.size}** members: renamed **${renamed}**` +
          (checked > renamed ? `, couldn't rename **${checked - renamed}** (above my role or the owner).` : ".")
      );
    },
  },

  // ---------------- top level
  setup: {
    gate: MANAGE,
    defer: false,
    async run(interaction, ctx) {
      const type = ctx.options.getString("type", true);
      const current = describeSetting(store.rules.get(ctx.guild.id), type);
      const submit = await askModal(interaction, setupModal(`flt:setup:${interaction.id}`, type, current));
      if (!submit) return;
      ctx.target = submit;
      const enabled = (submit.fields.getStringSelectValues("enabled")[0] ?? "on") === "on";
      const punishment = type === "names" ? null : submit.fields.getStringSelectValues("punishment")[0] ?? null;
      const thresholdText = THRESHOLDS[type] ? submit.fields.getTextInputValue("threshold").trim() : "";
      ensure(!thresholdText || /^\d+$/.test(thresholdText), "The threshold must be a whole number.");
      const threshold = checkThreshold(type, thresholdText ? Number(thresholdText) : null);
      const durationText = type === "names" ? "" : submit.fields.getTextInputValue("duration").trim();
      const durationMs = parsePunishDuration(durationText, punishment);
      store.setSetting(ctx.guild.id, type, "", { enabled, threshold, punishment, durationMs });
      const s = describeSetting(store.rules.get(ctx.guild.id), type);
      await ctx.success(`**${type}** filter: ${formatSetting(type, s)}${await syncLine(ctx.guild, type)}`);
    },
  },
  set: {
    gate: MANAGE,
    async run(interaction, ctx) {
      const type = ctx.options.getString("type", true);
      const enabled = ctx.options.getBoolean("setting", true);
      const channel = ctx.options.getChannel("channel");
      const threshold = checkThreshold(type, ctx.options.getInteger("threshold"));
      const punishment = ctx.options.getString("punishment");
      ensure(!(type === "names" && punishment), "The names filter renames members; it doesn't take a punishment.");
      const before = describeSetting(store.rules.get(ctx.guild.id), type, channel?.id);
      const durationMs = parsePunishDuration(ctx.options.getString("duration"), punishment ?? before.punishment);

      store.setSetting(ctx.guild.id, type, channel?.id ?? "", { enabled, threshold, punishment, durationMs });
      const s = describeSetting(store.rules.get(ctx.guild.id), type, channel?.id);
      const notes = [];
      if (durationMs && !TIMED.has(s.punishment)) notes.push(`-# The duration only applies to ${[...TIMED].join(", ")}.`);
      if (s.punishment === "points" && !store.rules.get(ctx.guild.id).ladder.length) notes.push("-# No points ladder yet: `/filter points setup`.");
      if (type === "links" && enabled && !store.listUrls(ctx.guild.id).length) notes.push("-# No sites are whitelisted, so every link is removed: `/filter url allow`.");
      if (type === "words" && enabled && !store.countWords(ctx.guild.id, "block") && !store.countWords(ctx.guild.id, "regex"))
        notes.push("-# The word list is empty: `/filter word add`.");
      await ctx.success(
        `**${type}** filter ${channel ? `in ${channel}` : "(server default)"}: ${formatSetting(type, s)}` +
          (notes.length ? `\n${notes.join("\n")}` : "") +
          (await syncLine(ctx.guild, type))
      );
    },
  },
  clear: {
    gate: MANAGE,
    async run(interaction, ctx) {
      const type = ctx.options.getString("type", true);
      const channel = ctx.options.getChannel("channel");
      const overrides = store.rules.get(ctx.guild.id).types.get(type)?.channels;
      ensure(overrides?.size && (!channel || overrides.has(channel.id)),
        channel ? `The **${type}** filter has no settings for ${channel}.` : `The **${type}** filter has no per-channel settings.`);
      const what = channel ? `the **${type}** filter's settings for ${channel}` : `all **${overrides.size}** per-channel settings of the **${type}** filter`;
      if (!(await ui.confirm(interaction, `Remove ${what}? Those channels will use the server default.`))) return;
      store.clearOverrides(ctx.guild.id, type, channel?.id);
      await ctx.success(`Removed ${what}.${await syncLine(ctx.guild, type)}`);
    },
  },
  config: {
    gate: MANAGE,
    async run(interaction, ctx) {
      const compiled = store.rules.get(ctx.guild.id);
      const type = ctx.options.getString("type");
      if (type) {
        const t = compiled.types.get(type);
        const exempt = [...(compiled.exempt.get(type) ?? [])].map((id) => `<@&${id}>`);
        const lines = [
          `-# ${DESCRIPTIONS[type]}`,
          `**Server default:** ${formatSetting(type, describeSetting(compiled, type))}`,
          `**Exempt roles:** ${exempt.join(", ") || "none"}`,
          ...(AUTOMOD_TYPES.includes(type) ? [`**AutoMod:** ${store.getAutomodRule(ctx.guild.id, type) ? "mirrored" : "not mirrored (bot-side)"}`] : []),
          ...(t?.channels.size ? ["", "**Per-channel settings**"] : []),
          ...[...(t?.channels.keys() ?? [])].map((id) => `<#${id}>: ${formatSetting(type, describeSetting(compiled, type, id))}`),
        ];
        return ui.paginate(interaction, ui.listPages(ctx.client, `Filter: ${type}`, lines, { perPage: 15 }));
      }
      const lines = TYPES.map((t) => {
        const overrides = compiled.types.get(t)?.channels.size ?? 0;
        return `\`${t}\` ${formatSetting(t, describeSetting(compiled, t))}${overrides ? ` · ${overrides} channel setting${overrides === 1 ? "" : "s"}` : ""}`;
      });
      await ui.paginate(interaction, ui.listPages(ctx.client, "Filters", lines, { perPage: 15, footer: "/filter config <type> for details" }));
    },
  },
  snipe: {
    gate: MANAGE,
    async run(interaction, ctx) {
      const type = ctx.options.getString("type", true);
      const enabled = ctx.options.getBoolean("setting", true);
      store.setSnipe(ctx.guild.id, type, enabled);
      await ctx.success(enabled ? `Messages with **${type}** are now hidden from snipe.` : `Messages with **${type}** show in snipe again.`);
    },
  },
};

// ------------------------------------------------------------------ tree

const data = new SlashCommandBuilder()
  .setName("filter")
  .setDescription("Chat filters, AutoMod and the points ladder")
  .addSubcommandGroup((g) =>
    g.setName("exempt").setDescription("Roles a filter ignores")
      .addSubcommand((s) => s.setName("add").setDescription("Exempt a role from a filter")
        .addStringOption((o) => typeOption(o))
        .addRoleOption((o) => o.setName("role").setDescription("Role to exempt").setRequired(true)))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove a role's exemption from a filter")
        .addStringOption((o) => typeOption(o))
        .addRoleOption((o) => o.setName("role").setDescription("Role to stop exempting").setRequired(true)))
      .addSubcommand((s) => s.setName("list").setDescription("View every role a filter ignores")
        .addStringOption((o) => typeOption(o))))
  .addSubcommandGroup((g) =>
    g.setName("word").setDescription("The word filter")
      .addSubcommand((s) => s.setName("add").setDescription("Add a word to the filter (* wildcards at start/end)")
        .addStringOption((o) => o.setName("word").setDescription("Word or phrase, e.g. bad, bad*, *bad*").setRequired(true).setMaxLength(LIMITS.wordLength)))
      .addSubcommand((s) => s.setName("remove").setDescription("Remove a word from the filter")
        .addStringOption((o) => o.setName("word").setDescription("Filtered word").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("list").setDescription("View every filtered and allowed word"))
      .addSubcommand((s) => s.setName("allow").setDescription("Allow a word through the filter")
        .addStringOption((o) => o.setName("word").setDescription("Word to allow").setRequired(true).setMaxLength(LIMITS.wordLength)))
      .addSubcommand((s) => s.setName("unallow").setDescription("Remove an allowed word from the filter")
        .addStringOption((o) => o.setName("word").setDescription("Allowed word").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("regex").setDescription("Add or remove a regex pattern on the filter")
        .addStringOption((o) => o.setName("pattern").setDescription("Regex pattern (case-insensitive)").setRequired(true).setMaxLength(LIMITS.regexLength).setAutocomplete(true))
        .addBooleanOption((o) => o.setName("setting").setDescription("True to add, false to remove").setRequired(true)))
      .addSubcommand((s) => s.setName("reset").setDescription("Clear the legacy word list"))
      .addSubcommand((s) => s.setName("migrate").setDescription("Copy the legacy word list into Discord AutoMod")))
  .addSubcommandGroup((g) =>
    g.setName("url").setDescription("The links filter whitelist")
      .addSubcommand((s) => s.setName("allow").setDescription("Whitelist a site from the links filter")
        .addStringOption((o) => o.setName("url").setDescription("Site, e.g. youtube.com").setRequired(true).setMaxLength(200)))
      .addSubcommand((s) => s.setName("disallow").setDescription("Remove a site from the links filter whitelist")
        .addStringOption((o) => o.setName("url").setDescription("Whitelisted site").setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName("list").setDescription("View every whitelisted site for the links filter")))
  .addSubcommandGroup((g) =>
    g.setName("points").setDescription("Points escalation")
      .addSubcommand((s) => s.setName("limit").setDescription("Set the most points a member can build up")
        .addIntegerOption((o) => o.setName("points").setDescription("Maximum points (0 removes the limit)").setRequired(true).setMinValue(0).setMaxValue(1000)))
      .addSubcommand((s) => s.setName("setup").setDescription("Set point values and the escalation ladder"))
      .addSubcommand((s) => s.setName("view").setDescription("View point values and the punishments they lead to"))
      .addSubcommand((s) => s.setName("member").setDescription("View a member's points")
        .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)))
      .addSubcommand((s) => s.setName("clear").setDescription("Remove a member's points")
        .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("How many (default: all)").setMinValue(1).setMaxValue(1000))))
  .addSubcommandGroup((g) =>
    g.setName("names").setDescription("The nickname filter")
      .addSubcommand((s) => s.setName("config").setDescription("View your name filter settings"))
      .addSubcommand((s) => s.setName("cleanup").setDescription("Clean every member's name now")))
  .addSubcommand((s) => s.setName("setup").setDescription("Set up a filter with a form")
    .addStringOption((o) => typeOption(o)))
  .addSubcommand((s) => s.setName("set").setDescription("Enable or disable a filter")
    .addStringOption((o) => typeOption(o))
    .addBooleanOption((o) => o.setName("setting").setDescription("Enable or disable").setRequired(true))
    .addChannelOption((o) => o.setName("channel").setDescription("Only this channel (default: whole server)").addChannelTypes(...TEXT_CHANNELS))
    .addIntegerOption((o) => o.setName("threshold").setDescription("Trigger level: % caps, # mentions/emojis/newlines, messages per 5s").setMinValue(1).setMaxValue(200))
    .addStringOption((o) => o.setName("punishment").setDescription("What happens on a hit").addChoices(...choices(PUNISHMENTS)))
    .addStringOption((o) => o.setName("duration").setDescription("For timeout/mute/jail/ban, e.g. 10m, 1h, 2d").setMaxLength(20)))
  .addSubcommand((s) => s.setName("clear").setDescription("Remove a filter's per-channel settings")
    .addStringOption((o) => typeOption(o))
    .addChannelOption((o) => o.setName("channel").setDescription("Only this channel (default: every channel)").addChannelTypes(...TEXT_CHANNELS)))
  .addSubcommand((s) => s.setName("config").setDescription("View your filter settings")
    .addStringOption((o) => o.setName("type").setDescription("Show one filter in detail").addChoices(...choices(TYPES))))
  .addSubcommand((s) => s.setName("snipe").setDescription("Filter a kind of content from snipe")
    .addStringOption((o) => typeOption(o, SNIPE_TYPES))
    .addBooleanOption((o) => o.setName("setting").setDescription("True to hide it from snipe").setRequired(true)));

module.exports = defineCommand({
  data,
  module: "filter",
  handlers,
  autocomplete: {
    "word remove": wordAutocomplete("block"),
    "word unallow": wordAutocomplete("allow"),
    "word regex": wordAutocomplete("regex"),
    "url disallow": (interaction) => (guard.check(interaction.member, MANAGE) ? [] : store.listUrls(interaction.guildId)),
  },
});
module.exports.setupModal = setupModal;
module.exports.pointsModal = pointsModal;
