/**
 * Reaction roles: members react to a menu message to pick a vanity role.
 *
 * The "board" is one channel holding an optional intro message followed by
 * groups of menus. Each menu is one message listing emoji -> role, with the
 * bot's own reactions as the buttons.
 *
 *   group.kind "colour"  roles carry a colour (or gradient / holographic)
 *   group.kind "icon"    roles carry a role icon taken from the option's emoji
 *   group.kind "plain"   ordinary roles
 *
 *   group.exclusive        a member keeps only one role from the whole group
 *   group.requiredRoleIds  only members with one of these roles may pick
 *                          (e.g. the booster role); empty = everyone
 *
 * The board is edited in the web panel and saved to data/reaction-roles.json.
 * Reactions arrive through events/guild/messageReactionAdd + Remove.
 */
const { randomUUID } = require("crypto");
const { PermissionFlagsBits, GuildFeature } = require("discord.js");
const store = require("./store");
const template = require("./reactionRoleTemplate");

const FILE = "reaction-roles";
const KINDS = new Set(["colour", "icon", "plain"]);
const MAX_MESSAGE_LENGTH = 2000;
// Discord allows 20 different reactions on one message.
const MAX_OPTIONS = 20;
// The colours Discord requires for the holographic role style.
const HOLOGRAPHIC = {
  primaryColor: 11127295,
  secondaryColor: 16759788,
  tertiaryColor: 16761760,
};

// ---------------------------------------------------------------- board

const str = (value, max) => String(value ?? "").trim().slice(0, max);
const snowflake = (value) => (/^\d{5,25}$/.test(String(value ?? "")) ? String(value) : "");
const hex = (value) => (/^#[0-9a-f]{6}$/i.test(String(value ?? "")) ? String(value).toUpperCase() : "");
const newId = () => randomUUID().slice(0, 8);

/**
 * Coerces a board from disk or from the panel into a valid one. Message ids
 * are owned by the bot: they are carried over from `previous`, never taken
 * from the request.
 */
function sanitize(input, previous) {
  const raw = input && typeof input === "object" ? input : {};
  const oldMenus = new Map();
  for (const group of previous?.groups ?? [])
    for (const menu of group.menus) oldMenus.set(menu.id, menu.messageId);
  const messageIdFor = (menu) =>
    previous ? oldMenus.get(menu.id) ?? null : snowflake(menu.messageId) || null;

  return {
    guildId: snowflake(raw.guildId),
    channelId: snowflake(raw.channelId),
    // Posted messages whose menu was removed in the panel; publish deletes them.
    staleMessageIds: (previous ? previous.staleMessageIds : Array.isArray(raw.staleMessageIds) ? raw.staleMessageIds : [])
      .map(snowflake)
      .filter(Boolean),
    removeUnknown: raw.removeUnknown !== false,
    raiseNewRoles: raw.raiseNewRoles !== false,
    intro: {
      content: String(raw.intro?.content ?? "").slice(0, MAX_MESSAGE_LENGTH),
      messageId: previous
        ? previous.intro.messageId
        : snowflake(raw.intro?.messageId) || null,
    },
    groups: (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 10).map((group) => ({
      id: str(group.id, 16) || newId(),
      name: str(group.name, 60) || "Group",
      kind: KINDS.has(group.kind) ? group.kind : "plain",
      rolePrefix: str(group.rolePrefix, 40),
      exclusive: Boolean(group.exclusive),
      requiredRoleIds: (Array.isArray(group.requiredRoleIds) ? group.requiredRoleIds : [])
        .map(snowflake)
        .filter(Boolean)
        .slice(0, 20),
      header: String(group.header ?? "").slice(0, 1000),
      menus: (Array.isArray(group.menus) ? group.menus : []).slice(0, 15).map((menu) => {
        const id = str(menu.id, 16) || newId();
        return {
          id,
          title: str(menu.title, 100) || "Menu",
          description: str(menu.description, 300),
          note: str(menu.note, 300),
          messageId: messageIdFor({ ...menu, id }),
          options: (Array.isArray(menu.options) ? menu.options : [])
            .slice(0, MAX_OPTIONS)
            .map((option) => ({
              id: str(option.id, 16) || newId(),
              code: str(option.code, 20),
              label: str(option.label, 80),
              emoji: str(option.emoji, 80),
              roleId: snowflake(option.roleId),
              colour: hex(option.colour),
              colour2: hex(option.colour2),
              holo: Boolean(option.holo),
            })),
        };
      }),
    })),
  };
}

/*
 * One board per server: guildId -> board. Saved as { boards: { [guildId]: board } }.
 * Files from before multi-server support held a single board; it is converted
 * on load (keyed by its guildId).
 */
const boards = new Map();
{
  const raw = store.read(FILE, null);
  const list = raw?.boards ? Object.values(raw.boards) : raw ? [raw] : [];
  for (const b of list) {
    const clean = sanitize(b);
    if (clean.guildId) boards.set(clean.guildId, clean);
  }
}

/** A server's board, or a fresh template board for it (not saved until edited). */
function boardFor(guildId) {
  const id = snowflake(guildId);
  if (!id) throw new Error("Pick a server first.");
  return boards.get(id) ?? sanitize({ guildId: id, groups: template() });
}

/**
 * Hands the posted menus to the /autorole reaction engine
 * (features/autorole), which does the actual role giving: exclusive groups,
 * required roles, stray-reaction removal, restore on rejoin, activity log.
 * This board is only the builder (editor, role creation/styling, posting).
 *
 * Runs after every change and once at startup (clientReady), so menus that
 * were posted before this existed keep working without being re-posted.
 * Messages that /autorole's own commands manage are never taken over.
 */
function syncToAutorole() {
  let total = 0;
  for (const board of boards.values()) total += syncBoard(board);
  return total;
}

function syncBoard(board) {
  const autorole = require("../handlers/features").api("autorole");
  if (!autorole?.syncManagedMenus || !board.guildId) return 0;
  const menus = [];
  for (const group of board.groups)
    for (const menu of group.menus) {
      if (!menu.messageId) continue;
      menus.push({
        messageId: menu.messageId,
        channelId: board.channelId,
        group: `panel:${group.id}`,
        exclusive: group.exclusive,
        removeUnknown: board.removeUnknown,
        required: group.requiredRoleIds,
        options: menu.options
          .filter((o) => o.emoji && o.roleId)
          .map((o) => ({ emojiKey: optionKey(o), emoji: o.emoji, roleId: o.roleId })),
      });
    }
  try {
    return autorole.syncManagedMenus(board.guildId, "panel", menus);
  } catch (err) {
    console.error("[reaction-roles] sync to /autorole failed:", err);
    return 0;
  }
}

function persist() {
  store.write(FILE, { boards: Object.fromEntries(boards) });
  syncToAutorole();
}

const getBoard = (guildId) => boardFor(guildId);

/** Every board (for checks / the panel). */
const allBoards = () => [...boards.values()];

function setBoard(input) {
  const previous = boardFor(input?.guildId);
  const board = sanitize(input, previous);
  boards.set(board.guildId, board);

  // Remember the messages of menus that were removed, so publish can delete them.
  const kept = new Set(board.groups.flatMap((g) => g.menus.map((m) => m.messageId)));
  for (const group of previous.groups)
    for (const menu of group.menus)
      if (menu.messageId && !kept.has(menu.messageId) && !board.staleMessageIds.includes(menu.messageId))
        board.staleMessageIds.push(menu.messageId);

  persist();
  return board;
}

// ---------------------------------------------------------------- emoji

/** "<:name:id>" / "<a:name:id>" / a Unicode emoji -> { id, name, animated } */
function parseEmoji(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const custom = /^<(a?):(\w+):(\d+)>$/.exec(value);
  return custom
    ? { id: custom[3], name: custom[2], animated: Boolean(custom[1]) }
    : { id: null, name: value, animated: false };
}

// Discord sometimes drops the variation selector (❤️ vs ❤), so ignore it.
const bare = (name) => String(name ?? "").replace(/️/g, "");
const emojiKey = (emoji) => (emoji ? emoji.id ?? bare(emoji.name) : null);
const optionKey = (option) => emojiKey(parseEmoji(option.emoji));

// ---------------------------------------------------------------- rendering

const roleName = (group, option) =>
  (group.rolePrefix
    ? `${group.rolePrefix}: ${option.code || option.label}`
    : option.label || option.code || "Role"
  ).slice(0, 100);

/** The text of one menu message. The group's header sits on its first menu. */
function renderMenu(group, menu) {
  const lines = [];
  if (group.menus[0] === menu && group.header.trim()) lines.push(group.header.trim());

  lines.push(`> __${menu.title}__`);
  if (menu.description) lines.push(`> ${menu.description}`);
  lines.push("> ");

  for (const option of menu.options) {
    if (!option.emoji) continue;
    const role = option.roleId ? `<@&${option.roleId}>` : `@${roleName(group, option)}`;
    lines.push(`> ${option.emoji} - *${role}${option.label ? `, ${option.label}` : ""}*`);
  }

  if (menu.note) lines.push("> ", "> *Notes:*", `> -# ${menu.note.replace(/\n+/g, " ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- jobs + log

/** Progress of the running (or last) publish / role job, shown in the panel. */
const job = { running: false, name: "", lines: [], ok: true };

/** Runs one long task at a time in the background; the panel polls `job`. */
function startJob(name, task) {
  if (job.running) throw new Error(`"${job.name}" is still running.`);
  Object.assign(job, { running: true, name, lines: [], ok: true });
  const say = (line) => job.lines.push(line);

  Promise.resolve()
    .then(() => task(say))
    .then(() => say("Done."))
    .catch((err) => {
      job.ok = false;
      say(`Failed: ${err?.message ?? err}`);
      console.error(`[reaction-roles] ${name} failed:`, err);
    })
    .finally(() => {
      job.running = false;
      persist();
    });
}

async function resolveTarget(client, board) {
  const guild = client.guilds.cache.get(board.guildId);
  if (!guild) throw new Error("Pick a server first (the bot is not in the saved one).");
  const me = guild.members.me ?? (await guild.members.fetchMe());
  return { guild, me };
}

// ---------------------------------------------------------------- roles

const toInt = (colour) => parseInt(colour.slice(1), 16);

/** The colour / icon a role should have, limited to what the server supports. */
function roleStyle(guild, group, option) {
  if (group.kind === "colour") {
    const gradients = guild.features.includes(GuildFeature.EnhancedRoleColors);
    if (option.holo && gradients) return { colors: { ...HOLOGRAPHIC } };
    if (!option.colour) return {};
    return {
      colors: {
        primaryColor: toInt(option.colour),
        secondaryColor: gradients && option.colour2 ? toInt(option.colour2) : null,
        tertiaryColor: null,
      },
    };
  }

  if (group.kind === "icon") {
    const emoji = parseEmoji(option.emoji);
    if (!emoji || !guild.features.includes(GuildFeature.RoleIcons)) return {};
    return emoji.id
      ? { icon: `https://cdn.discordapp.com/emojis/${emoji.id}.png?size=128`, unicodeEmoji: null }
      : { unicodeEmoji: emoji.name, icon: null };
  }

  return {};
}

/**
 * Creates the role for every option that has none (re-using a role with the
 * same name if it exists) and, with `restyle`, pushes the configured colours
 * and icons onto the roles that already exist.
 */
function ensureRoles(client, guildId, { restyle = false } = {}) {
  const board = boardFor(guildId);
  boards.set(board.guildId, board);
  startJob("Create roles", async (say) => {
    const { guild, me } = await resolveTarget(client, board);
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
      throw new Error("I need the Manage Roles permission.");

    await guild.roles.fetch();
    if (board.groups.some((g) => g.kind === "colour" && g.menus.some((m) => m.options.some((o) => o.colour2 || o.holo))) &&
        !guild.features.includes(GuildFeature.EnhancedRoleColors))
      say("Note: this server has no Enhanced Role Styles, so gradients use their first colour.");
    if (board.groups.some((g) => g.kind === "icon") && !guild.features.includes(GuildFeature.RoleIcons))
      say("Note: this server has no role icons (boost level 2), so icon roles are created without an icon.");

    let created = 0;
    let updated = 0;
    for (const group of board.groups) {
      for (const menu of group.menus) {
        for (const option of menu.options) {
          const name = roleName(group, option);
          try {
            let role = guild.roles.cache.get(option.roleId);
            const mapped = Boolean(role);
            role ??= guild.roles.cache.find((r) => r.name === name && !r.managed);
            const style = roleStyle(guild, group, option);

            if (!role) {
              role = await guild.roles.create({
                name,
                permissions: [],
                mentionable: false,
                reason: "Reaction roles (web panel)",
                ...style,
              });
              created++;
              // A colour only shows when it is the member's highest coloured
              // role, so lift new roles to just under the bot's own role.
              if (board.raiseNewRoles && me.roles.highest.position > 1)
                await role
                  .setPosition(me.roles.highest.position - 1)
                  .catch((err) => say(`Could not raise ${name}: ${err.message}`));
            } else if (restyle && Object.keys(style).length) {
              if (!role.editable) say(`Skipped ${role.name}: it is above my highest role.`);
              else {
                await role.edit({ ...style, reason: "Reaction roles (web panel)" });
                updated++;
              }
            }

            if (!mapped || option.roleId !== role.id) option.roleId = role.id;
          } catch (err) {
            say(`${name}: ${err.message}`);
          }
        }
      }
      persist();
    }
    say(`${created} role(s) created, ${updated} restyled.`);
    reportUnassignable(guild, board, say);
  });
}

/**
 * Roles of this board the bot can't hand out (above its highest role, or
 * managed). Discord forbids that even with Administrator, so reactions on
 * those options would do nothing; the job log says so.
 */
function unassignableRoles(guild, board) {
  const me = guild.members.me;
  const out = [];
  for (const group of board.groups)
    for (const menu of group.menus)
      for (const option of menu.options) {
        const role = option.roleId && guild.roles.cache.get(option.roleId);
        if (role && (role.managed || !me || me.roles.highest.comparePositionTo(role) <= 0)) out.push(role);
      }
  return out;
}

function reportUnassignable(guild, board, say) {
  const bad = unassignableRoles(guild, board);
  if (!bad.length) return;
  say(
    `⚠ ${bad.length} role(s) are above my highest role (@${guild.members.me?.roles.highest.name ?? "?"}), so I can't give them out ` +
      `(e.g. @${bad[0].name}). In Server Settings → Roles, drag my role above them; nothing else needs redoing.`
  );
}

// ---------------------------------------------------------------- publishing

const CHANNEL_PERMISSIONS = [
  ["ViewChannel", "View Channel"],
  ["SendMessages", "Send Messages"],
  ["ReadMessageHistory", "Read Message History"],
  ["AddReactions", "Add Reactions"],
  ["UseExternalEmojis", "Use External Emoji"],
];

/** Brings the bot's own reactions on a menu message in line with its options. */
async function syncReactions(client, message, menu, say) {
  const wanted = new Map();
  for (const option of menu.options) {
    const emoji = parseEmoji(option.emoji);
    if (emoji) wanted.set(emojiKey(emoji), emoji);
  }

  for (const reaction of message.reactions.cache.values())
    if (reaction.me && !wanted.has(emojiKey(reaction.emoji)))
      await reaction.users.remove(client.user.id).catch(() => {});

  for (const [key, emoji] of wanted) {
    const existing = message.reactions.cache.find((r) => emojiKey(r.emoji) === key);
    if (existing?.me) continue;
    try {
      await message.react(emoji.id ?? emoji.name);
    } catch (err) {
      say(`"${menu.title}": could not react with ${emoji.name} (${err.message})`);
    }
  }
}

/**
 * Posts the board, or edits the messages already posted. `repost` deletes
 * the old messages first so everything is sent again in order (members'
 * reactions are lost, their roles are not).
 */
function publish(client, guildId, { repost = false } = {}) {
  const board = boardFor(guildId);
  boards.set(board.guildId, board);
  startJob(repost ? "Repost" : "Publish", async (say) => {
    const { guild, me } = await resolveTarget(client, board);
    const channel = await guild.channels.fetch(board.channelId).catch(() => null);
    if (!channel?.isTextBased()) throw new Error("Pick a text channel first.");

    const perms = channel.permissionsFor(me);
    const missing = CHANNEL_PERMISSIONS.filter(([flag]) => !perms?.has(PermissionFlagsBits[flag]));
    if (missing.length)
      throw new Error(`In #${channel.name} I am missing: ${missing.map((m) => m[1]).join(", ")}.`);
    if (!perms.has(PermissionFlagsBits.ManageMessages))
      say("Note: without Manage Messages I cannot remove members' reactions (stray emoji, role swaps).");

    // Everything that gets a message, in posting order.
    const items = [];
    if (board.intro.content.trim())
      items.push({ holder: board.intro, label: "Intro", content: board.intro.content.trim() });
    for (const group of board.groups)
      for (const menu of group.menus)
        items.push({ holder: menu, menu, label: menu.title, content: renderMenu(group, menu) });

    const tooLong = items.find((item) => item.content.length > MAX_MESSAGE_LENGTH);
    if (tooLong)
      throw new Error(
        `"${tooLong.label}" is ${tooLong.content.length} characters; Discord allows ${MAX_MESSAGE_LENGTH}. Split it into two menus.`
      );

    for (const id of board.staleMessageIds.splice(0)) {
      await channel.messages.delete(id).catch(() => {});
      say("Deleted a removed menu.");
    }

    if (repost) {
      for (const { holder } of [{ holder: board.intro }, ...items]) {
        if (!holder.messageId) continue;
        await channel.messages.delete(holder.messageId).catch(() => {});
        holder.messageId = null;
      }
    } else if (!board.intro.content.trim() && board.intro.messageId) {
      await channel.messages.delete(board.intro.messageId).catch(() => {});
      board.intro.messageId = null;
    }

    for (const item of items) {
      const payload = { content: item.content, allowedMentions: { parse: [] } };
      let message = item.holder.messageId
        ? await channel.messages.fetch(item.holder.messageId).catch(() => null)
        : null;

      if (message) {
        if (message.content !== item.content) await message.edit(payload);
        say(`Updated "${item.label}".`);
      } else {
        message = await channel.send(payload);
        item.holder.messageId = message.id;
        say(`Posted "${item.label}".`);
      }
      persist();

      if (item.menu) {
        const unmapped = item.menu.options.filter((o) => o.emoji && !o.roleId).length;
        if (unmapped) say(`"${item.label}": ${unmapped} option(s) have no role yet. Run "Create roles".`);
        await syncReactions(client, message, item.menu, say);
      }
    }
    await guild.roles.fetch().catch(() => {});
    reportUnassignable(guild, board, say);
  });
}

module.exports = {
  getBoard,
  setBoard,
  allBoards,
  sanitize,
  template,
  renderMenu,
  roleName,
  parseEmoji,
  ensureRoles,
  publish,
  syncToAutorole,
  job,
  MAX_MESSAGE_LENGTH,
};
