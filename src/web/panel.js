/**
 * The engine behind the panel's per-server settings (web/panelSchema.js).
 *
 * Reads and writes the same tables and guild_config keys the slash commands
 * use, validates every value the way the commands do (channel/role exists in
 * that server, script renders, emoji usable, role assignable...), then drops
 * that server's caches so listeners pick the change up immediately.
 *
 * Table and column names only ever come from the schema, never from the
 * request; values are always bound parameters.
 */
const { ChannelType } = require("discord.js");
const { db, config, script, parse, guard, guildCache, UserError } = require("../core");
const PACKAGES = require("./panelSchema");

const findPackage = (id) => {
  const pkg = PACKAGES.find((p) => p.id === id);
  if (!pkg) throw new UserError("Unknown settings page.");
  return pkg;
};
const findSection = (pkg, index) => {
  const section = pkg.sections[Number(index)];
  if (!section) throw new UserError("Unknown settings section.");
  return section;
};

// ---------------------------------------------------------------- table info

const pkCache = new Map();
function primaryKey(table) {
  if (!pkCache.has(table)) {
    const cols = db.all(`PRAGMA table_info(${table})`);
    if (!cols.length) throw new Error(`panel: table ${table} does not exist`);
    pkCache.set(table, {
      pk: cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      cols: cols.map((c) => c.name),
    });
  }
  return pkCache.get(table);
}

// ---------------------------------------------------------------- validation

const isEmpty = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Command paths ("levels rank") and top-level names, for access fields. */
function commandPaths(client) {
  const paths = new Set();
  for (const command of client.commands.values()) {
    const json = command.data.toJSON();
    paths.add(json.name);
    for (const o of json.options ?? []) {
      if (o.type === 2) for (const s of o.options ?? []) paths.add(`${json.name} ${o.name} ${s.name}`);
      else if (o.type === 1) paths.add(`${json.name} ${o.name}`);
    }
  }
  return paths;
}

/** Turns a submitted value into what the table stores, or throws UserError. */
function coerce(field, raw, guild) {
  const label = field.label;
  if (isEmpty(raw)) {
    if (field.type === "bool" && !field.optional) return 0;
    if (field.optional) return field.empty ?? null;
    throw new UserError(`"${label}" is required.`);
  }
  const value = typeof raw === "string" ? raw.trim() : raw;

  switch (field.type) {
    case "bool":
      return value === true || value === "true" || value === 1 || value === "1" ? 1 : 0;
    case "int":
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n) || (field.type === "int" && !Number.isInteger(n)))
        throw new UserError(`"${label}" must be a ${field.type === "int" ? "whole number" : "number"}.`);
      if (field.min != null && n < field.min) throw new UserError(`"${label}" must be at least ${field.min}.`);
      if (field.max != null && n > field.max) throw new UserError(`"${label}" must be at most ${field.max}.`);
      return n;
    }
    case "text": {
      let text = String(value);
      if (field.max && text.length > field.max) throw new UserError(`"${label}" is longer than ${field.max} characters.`);
      if (field.lower) text = text.toLowerCase();
      return text;
    }
    case "script":
      return script.validate(String(value));
    case "channel":
    case "voice":
    case "category": {
      const channel = guild.channels.cache.get(String(value));
      if (!channel) throw new UserError(`"${label}": that channel isn't in this server.`);
      const ok =
        field.type === "voice" ? channel.isVoiceBased()
        : field.type === "category" ? channel.type === ChannelType.GuildCategory
        : channel.isTextBased();
      if (!ok) throw new UserError(`"${label}": #${channel.name} is the wrong kind of channel.`);
      return channel.id;
    }
    case "role": {
      const role = guild.roles.cache.get(String(value));
      if (!role || role.id === guild.id) throw new UserError(`"${label}": pick a role from this server (not @everyone).`);
      if (field.assignable && !guard.botCanManageRole(guild, role))
        throw new UserError(`"${label}": I can't give out ${role.name}. It's managed, or above my highest role.`);
      return role.id;
    }
    case "select":
      if (!field.options.some((o) => String(o.value) === String(value))) throw new UserError(`"${label}": not one of the choices.`);
      return field.options.find((o) => String(o.value) === String(value)).value;
    case "emoji":
      return parse.emoji(String(value), guild.client).text;
    case "colour":
      return parse.colour(String(value));
    case "duration":
      return parse.duration(String(value));
    case "member":
    case "snowflake":
      if (!/^\d{15,25}$/.test(String(value))) throw new UserError(`"${label}" must be a Discord ID (enable Developer Mode, right-click → Copy ID).`);
      return String(value);
    case "commandPath":
      if (!commandPaths(guild.client).has(String(value).toLowerCase())) throw new UserError(`"${label}": no command called /${value}.`);
      return String(value).toLowerCase();
    case "module":
      if (!guild.client.commands.has(String(value))) throw new UserError(`"${label}": no module called ${value}.`);
      return String(value);
    default:
      throw new Error(`panel: unknown field type ${field.type}`);
  }
}

/** How a stored value is sent to the browser (inverse of coerce where needed). */
function present(field, value) {
  if (value === null || value === undefined || value === "") return field.type === "bool" && !field.optional ? false : null;
  switch (field.type) {
    case "bool": return Boolean(value);
    case "colour": return parse.hex(value);
    case "duration": return parse.formatDuration(value);
    default: return value;
  }
}

// ---------------------------------------------------------------- display labels

/** Adds human labels for IDs (channels, roles, users) so the UI can show names. */
async function labelsFor(guild, rows, columns) {
  const labels = {};
  const userIds = new Set();
  for (const row of rows)
    for (const column of columns) {
      const v = row[column.col];
      if (!v) continue;
      if (["channel", "voice", "category"].includes(column.type)) {
        const c = guild.channels.cache.get(v);
        labels[v] = c ? { text: `#${c.name}` } : { text: "deleted channel", missing: true };
      } else if (column.type === "role") {
        const r = guild.roles.cache.get(v);
        labels[v] = r ? { text: `@${r.name}`, colour: r.hexColor !== "#000000" ? r.hexColor : null } : { text: "deleted role", missing: true };
      } else if (column.type === "user" || column.type === "member" || (column.type === "snowflake" && /^\d+$/.test(v))) {
        if (column.type === "snowflake") {
          const c = guild.channels.cache.get(v);
          const r = guild.roles.cache.get(v);
          if (c) { labels[v] = { text: `#${c.name}` }; continue; }
          if (r) { labels[v] = { text: `@${r.name}` }; continue; }
        }
        userIds.add(v);
      }
    }
  if (userIds.size) {
    const missing = [...userIds].filter((id) => !guild.members.cache.has(id));
    if (missing.length)
      await Promise.race([
        guild.members.fetch({ user: missing.slice(0, 100) }).catch(() => null),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    for (const id of userIds) {
      const m = guild.members.cache.get(id);
      const u = m?.user ?? guild.client.users.cache.get(id);
      labels[id] = u ? { text: m?.displayName ?? u.username, sub: u.username } : { text: id };
    }
  }
  return labels;
}

// ---------------------------------------------------------------- read

function readSection(guild, section) {
  const gid = guild.id;
  if (section.kind === "note" || section.kind === "oauth") return {};
  if (section.kind === "commandLevels") return { commands: commandLevelRows(guild) };
  if (section.kind === "config") {
    const values = {};
    for (const f of section.fields) values[f.key] = present(f, config.get(gid, f.key));
    return { values };
  }
  if (section.kind === "row") {
    const keys = section.keys ?? {};
    const where = ["guild_id = ?", ...Object.keys(keys).map((k) => `${k} = ?`)].join(" AND ");
    const row = db.get(`SELECT * FROM ${section.table} WHERE ${where}`, gid, ...Object.values(keys)) ?? {};
    const values = {};
    for (const f of section.fields) values[f.col] = f.type === "readonly" ? row[f.col] ?? null : present(f, row[f.col]);
    return { values };
  }
  if (section.kind === "list") {
    const keys = section.keys ?? {};
    const where = ["guild_id = ?", ...Object.keys(keys).map((k) => `${k} = ?`)].join(" AND ");
    const { pk } = primaryKey(section.table);
    const rows = db.all(`SELECT * FROM ${section.table} WHERE ${where} LIMIT 500`, gid, ...Object.values(keys)).map((row) => {
      const out = { _key: Object.fromEntries(pk.filter((c) => c !== "guild_id").map((c) => [c, row[c]])) };
      for (const f of section.fields) out[f.col] = present(f, row[f.col]);
      return out;
    });
    return { rows };
  }
  if (section.kind === "view") {
    const rows = db.all(section.sql, gid).map((row) => {
      const out = { ...row };
      if (section.remove) out._key = Object.fromEntries(section.remove.keys.map((k) => [k, row[k]]));
      return out;
    });
    return { rows };
  }
  throw new Error(`panel: unknown section kind ${section.kind}`);
}

async function readPackage(guild, pkgId) {
  const pkg = findPackage(pkgId);
  const sections = [];
  for (const section of pkg.sections) {
    const data = readSection(guild, section);
    if (!section.fields && !section.columns) {
      sections.push(data);
      continue;
    }
    const cols = section.kind === "view" ? section.columns : section.fields.map((f) => ({ col: f.col ?? f.key, type: f.type }));
    const rows = data.rows ?? [data.values ?? {}];
    data.labels = await labelsFor(guild, rows.map((r) => ({ ...r, ...(r._key ?? {}) })), cols);
    sections.push(data);
  }
  return { sections };
}

// ---------------------------------------------------------------- write

const AUTO = { now: () => Date.now() };
const autoValues = (section) =>
  Object.fromEntries(Object.entries(section.auto ?? {}).map(([col, v]) => [col, AUTO[v] ? AUTO[v]() : v]));

function upsert(table, values) {
  const { pk } = primaryKey(table);
  const cols = Object.keys(values);
  const update = cols.filter((c) => !pk.includes(c));
  const sql =
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ` +
    `ON CONFLICT (${pk.join(", ")}) DO ${update.length ? `UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(", ")}` : "NOTHING"}`;
  db.run(sql, ...cols.map((c) => values[c]));
}

async function afterWrite(guild, section) {
  // Every package caches its settings per server; drop them all for this server.
  guildCache.invalidateGuild(guild.id);
  // Moderator/admin lists changed: update who sees staff commands (if connected).
  if (section.table === "access_levels") require("./oauth").scheduleSync(guild.client, guild.id);
  return section.afterSave ? await section.afterSave(guild) : null;
}

/** Saves a config or row section. `input` = { field: value }. */
async function saveSection(guild, pkgId, index, input = {}) {
  const section = findSection(findPackage(pkgId), index);
  const editable = section.fields.filter((f) => f.type !== "readonly");

  if (section.kind === "config") {
    const values = editable.map((f) => [f.key, f.key in input ? coerce(f, input[f.key], guild) : undefined]);
    for (const [key, value] of values) {
      if (value === undefined) continue;
      if (value === null || value === "") config.remove(guild.id, key);
      else config.set(guild.id, key, typeof value === "number" && editable.find((f) => f.key === key).type === "bool" ? Boolean(value) : value);
    }
  } else if (section.kind === "row") {
    const values = { guild_id: guild.id, ...(section.keys ?? {}) };
    for (const f of editable) if (f.col in input) values[f.col] = coerce(f, input[f.col], guild);
    upsert(section.table, values);
  } else throw new UserError("That section isn't a form.");

  return { warning: await afterWrite(guild, section) };
}

/** Adds (or, when the key already exists, updates) a list row. */
async function addRow(guild, pkgId, index, input = {}) {
  const section = findSection(findPackage(pkgId), index);
  if (section.kind !== "list") throw new UserError("Rows can't be added here.");
  const values = { guild_id: guild.id, ...(section.keys ?? {}), ...autoValues(section) };
  for (const f of section.fields) values[f.col] = coerce(f, input[f.col], guild);
  // Optional key columns that were left empty must still satisfy NOT NULL.
  for (const [col, v] of Object.entries(values)) if (v === undefined) delete values[col];
  upsert(section.table, values);
  return { warning: await afterWrite(guild, section) };
}

/** Deletes one row of a list (or of a view that allows removal) by its key. */
async function deleteRow(guild, pkgId, index, key = {}) {
  const section = findSection(findPackage(pkgId), index);
  let table, keyCols;
  if (section.kind === "list") {
    table = section.table;
    keyCols = primaryKey(table).pk.filter((c) => c !== "guild_id");
  } else if (section.kind === "view" && section.remove) {
    table = section.remove.table;
    keyCols = section.remove.keys;
  } else throw new UserError("Rows can't be removed here.");

  for (const c of keyCols) if (!(c in key)) throw new UserError("Missing row key.");
  const fixed = section.keys ?? {};
  const where = ["guild_id = ?", ...keyCols.map((c) => `${c} = ?`), ...Object.keys(fixed).map((k) => `${k} = ?`)];
  const result = db.run(`DELETE FROM ${table} WHERE ${where.join(" AND ")}`, guild.id, ...keyCols.map((c) => key[c]), ...Object.values(fixed));
  if (!result.changes) throw new UserError("That row no longer exists.");
  return { warning: await afterWrite(guild, section) };
}

/** Renders a script for the preview pane. */
function previewScript(guild, member, text) {
  const payload = script.render(script.validate(String(text ?? "")), {
    member, guild, channel: guild.systemChannel ?? null,
    vars: { level: 5, xp: 1200, next_level: 6, next_xp: 1500, rank: 3, prize: "Nitro", winners: 1, reason: "Example reason", moderator: "@Moderator", duration: "10m", case: 42 },
  });
  return {
    content: payload.content === "​" ? "" : payload.content ?? "",
    embeds: payload.embeds.map((e) => e.toJSON()),
    buttons: payload.components.flatMap((row) => row.components.map((b) => ({ label: b.data.label, url: b.data.url }))),
  };
}

// ---------------------------------------------------------------- command levels

/** Every command with its default/overridden level, grouped by package, for the Permissions page. */
function commandLevelRows(guild) {
  const { levels, PERMISSION_GATES } = guard;
  const overrides = levels.commandOverrides(guild.id);
  const packageOf = new Map();
  for (const f of require("../handlers/features").loadFeatures()) for (const c of f.commands) packageOf.set(c.data.name, f.name);

  return [...guild.client.commands.values()]
    .map((command) => {
      const json = command.data.toJSON();
      const name = json.name;
      const subs = command.handlers
        ? Object.entries(command.handlers).map(([key, h]) => ({
            path: key ? `${name} ${key}` : name,
            default: levels.name(levels.gateLevel(h.gate, PERMISSION_GATES)),
          }))
        : [{ path: name, default: levels.name(levels.bitsLevel(json.default_member_permissions)) }];
      const defaults = [...new Set(subs.map((s) => s.default))];
      return {
        name,
        description: json.description,
        package: packageOf.get(name) ?? "other",
        default: defaults.length === 1 ? defaults[0] : "mixed",
        override: overrides[name] ?? null,
        subs: subs.filter((s) => s.path !== name).map((s) => ({ ...s, override: overrides[s.path] ?? null })),
      };
    })
    .sort((a, b) => a.package.localeCompare(b.package) || a.name.localeCompare(b.name));
}

/** Sets (or clears, with an empty level) the required level of a command path. */
function setCommandLevel(guild, command, level) {
  const path = String(command ?? "").trim().toLowerCase();
  if (!commandPaths(guild.client).has(path)) throw new UserError(`No command called /${command}.`);
  if (level && !guard.levels.LEVELS.includes(level)) throw new UserError("Unknown level.");
  guard.levels.setCommandLevel(guild.id, path, level || null);
  require("./oauth").scheduleSync(guild.client, guild.id);
  return { ok: true };
}

/** Member search for the panel's member pickers. */
async function searchMembers(guild, query) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const found = /^\d{15,25}$/.test(q)
    ? await guild.members.fetch(q).then((m) => [m]).catch(() => [])
    : [...(await guild.members.search({ query: q, limit: 10 }).catch(() => new Map())).values()];
  return found.map((m) => ({ id: m.id, name: m.displayName, username: m.user.username }));
}

/** The schema for the browser, without functions or SQL. */
const publicSchema = () =>
  PACKAGES.map((p) => ({
    id: p.id, title: p.title, icon: p.icon, command: p.command,
    sections: p.sections.map((s) => ({
      kind: s.kind, title: s.title, help: s.help,
      fields: s.fields?.map(({ key, col, label, type, options, optional, min, max, format, assignable }) => ({ name: col ?? key, label, type, options, optional, min, max, format, assignable })),
      columns: s.columns,
      removable: s.kind === "list" || Boolean(s.remove),
    })),
  }));

module.exports = { publicSchema, readPackage, saveSection, addRow, deleteRow, previewScript, commandPaths, commandLevelRows, setCommandLevel, searchMembers, PACKAGES };
