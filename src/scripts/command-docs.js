/**
 * Generates docs/COMMANDS.md from the registered command definitions, so the
 * reference always matches the code. Doesn't log in to Discord.
 *
 *   npm run docs:commands
 *
 * For each command: package, description, and every subcommand with its
 * permission (the router gate) and options (type, required, choices, limits).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// Use a throwaway database: loading packages runs their migrations.
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "banada-docs-"));

const { ApplicationCommandOptionType: T, PermissionsBitField } = require("discord.js");

// Silence the loaders' "[SUCCESS] Loaded ..." chatter.
const log = console.log;
console.log = () => {};
const { loadFeatures } = require("../handlers/features");
const features = loadFeatures();
console.log = log;

const OUT = path.join(__dirname, "..", "..", "docs", "COMMANDS.md");

const TYPE_NAMES = {
  [T.String]: "text", [T.Integer]: "integer", [T.Number]: "number", [T.Boolean]: "true/false",
  [T.User]: "user", [T.Channel]: "channel", [T.Role]: "role", [T.Mentionable]: "user or role",
  [T.Attachment]: "file",
};

const PACKAGE_TITLES = {
  music: "Music", general: "General", moderation: "Moderation", "server-admin": "Server admin",
  filter: "Chat filter", config: "Server config", boosterrole: "Booster roles & badges",
  suggest: "Suggestions", autoresponder: "Autoresponders & reactions", automation: "Automation",
  autorole: "Auto roles", voicemaster: "VoiceMaster", levels: "Levels", giveaways: "Giveaways",
  boards: "Starboard & clownboard", bumpreminder: "Bump reminder",
};
// Packages in a reading order; anything new is appended alphabetically.
const ORDER = Object.keys(PACKAGE_TITLES);

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const anchor = (s) => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");

function describeOption(o) {
  const bits = [TYPE_NAMES[o.type] ?? "?"];
  if (o.min_value != null || o.max_value != null) bits.push(`${o.min_value ?? "…"}–${o.max_value ?? "…"}`);
  if (o.min_length != null || o.max_length != null) bits.push(`${o.min_length ?? 0}–${o.max_length ?? "…"} chars`);
  if (o.autocomplete) bits.push("autocomplete");
  let text = `\`${o.name}\`${o.required ? "" : " *(optional)*"} (${bits.join(", ")}): ${esc(o.description)}`;
  if (o.choices?.length) text += ` Choices: ${o.choices.map((c) => `\`${esc(c.name)}\``).join(", ")}.`;
  return text;
}

const LEVEL_NAMES = ["Members", "Moderators", "Admins", "Owner"];

/** Who can run a subcommand by default: access level, plus the finer permission gate. */
function permission(command, json, key) {
  const { guard } = require("../core");
  const handler = command.handlers?.[key];
  if (handler) {
    const level = LEVEL_NAMES[guard.levels.gateLevel(handler.gate, guard.PERMISSION_GATES)];
    const gate = handler.gate ? (Array.isArray(handler.gate) ? handler.gate.join(" + ") : handler.gate) : null;
    return gate && gate !== "Server Owner" ? `${level} (${gate})` : level;
  }
  if (json.default_member_permissions && json.default_member_permissions !== "0")
    return `${LEVEL_NAMES[guard.levels.bitsLevel(json.default_member_permissions)]} (${permissionNames(json.default_member_permissions)})`;
  return "Members";
}

function permissionNames(bits) {
  return new PermissionsBitField(BigInt(bits)).toArray().map((n) => n.replace(/([a-z])([A-Z])/g, "$1 $2")).join(" + ");
}

function leafRows(command) {
  const json = command.data.toJSON();
  const rows = [];
  const push = (pathParts, leaf) => {
    const key = pathParts.join(" ");
    rows.push({
      usage: `/${[json.name, ...pathParts].join(" ")}`,
      description: leaf.description,
      permission: permission(command, json, key),
      options: (leaf.options ?? []).filter((o) => o.type !== T.Subcommand && o.type !== T.SubcommandGroup),
    });
  };
  const top = json.options ?? [];
  const subs = top.filter((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup);
  if (!subs.length) push([], json);
  for (const o of subs) {
    if (o.type === T.SubcommandGroup) for (const s of o.options ?? []) push([o.name, s.name], s);
    else push([o.name], o);
  }
  return { json, rows };
}

const sorted = [...features].sort((a, b) => {
  const ia = ORDER.indexOf(a.name), ib = ORDER.indexOf(b.name);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.name.localeCompare(b.name);
});

let total = 0, leaves = 0;
const sections = [];
const toc = [];
for (const feature of sorted) {
  if (!feature.commands.length) continue;
  const title = PACKAGE_TITLES[feature.name] ?? feature.name;
  toc.push(`- [${title}](#${anchor(title)}): ${feature.commands.map((c) => `\`/${c.data.name}\``).join(" ")}`);
  const out = [`## ${title}`, ""];
  for (const command of [...feature.commands].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
    const { json, rows } = leafRows(command);
    total++;
    leaves += rows.length;
    out.push(`### /${json.name}`, "", esc(json.description), "");
    if (rows.length === 1 && rows[0].usage === `/${json.name}`) {
      const r = rows[0];
      out.push(`**Permission:** ${r.permission}`, "");
      if (r.options.length) out.push(...r.options.map((o) => `- ${describeOption(o)}`), "");
      continue;
    }
    out.push("| Command | What it does | Permission | Options |", "|---|---|---|---|");
    for (const r of rows)
      out.push(`| \`${r.usage}\` | ${esc(r.description)} | ${r.permission} | ${r.options.length ? r.options.map(describeOption).join("<br>") : "—"} |`);
    out.push("");
  }
  sections.push(out.join("\n"));
}

const doc = [
  "# Banada Bot: command reference",
  "",
  "> Generated from the code by `npm run docs:commands` (src/scripts/command-docs.js). Don't edit by hand;",
  "> change the command definitions and regenerate.",
  "",
  `${total} top-level commands, ${leaves} commands in total including subcommands.`,
  "",
  "**Permissions.** Each entry shows the default *access level* (Members < Moderators < Admins < Owner) and,",
  "in brackets, the Discord permission also checked. Each server can change any command's level, and choose its",
  "moderator/admin roles and users, in the web panel (Server → Permissions). Staff commands are hidden in Discord",
  "from members without Manage Messages (moderator commands) or Manage Server (admin commands).",
  "Any command can also be switched off per channel or member with `/access`; `/ignore` ignores members/channels.",
  "",
  "**Messages.** Commands that set a custom message (welcome, level-up, reminders...) open a form. Plain text",
  "works, and so do variables such as `{user.mention}`, `{guild.name}` and `{guild.count}`. For embeds, paste",
  "a JSON script (see docs/bleed-server-mgmt-guide/CORE.md, \"script\").",
  "",
  "## Contents",
  "",
  ...toc,
  "",
  ...sections,
].join("\n");

fs.writeFileSync(OUT, doc.trimEnd() + "\n");
log(`Wrote ${path.relative(process.cwd(), OUT)}: ${total} commands, ${leaves} including subcommands.`);
process.exit(0);
