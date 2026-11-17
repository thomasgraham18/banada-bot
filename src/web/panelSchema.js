/**
 * What the web panel can show and edit for each feature package.
 *
 * This is pure description; web/panel.js does the reading, validating and
 * writing. Each package is a list of sections:
 *
 *   { kind: "config", fields }          guild_config keys (core/config.js)
 *   { kind: "row", table, keys, fields } one row per server (+ fixed keys, e.g. board kind)
 *   { kind: "list", table, keys, fields, add, remove }  many rows; add / edit / delete
 *   { kind: "view", sql, columns, remove? }             read-only listing (+ optional delete)
 *
 * Field types: bool, int, number, text, script, channel, voice, category,
 * role, select, emoji, colour (stored as int), duration (stored as ms),
 * seconds, snowflake (any Discord ID), readonly.
 *
 * Things that need Discord-side work to create (giveaways, timers, counters,
 * reaction/button roles, aliases, webhooks...) are shown as views. Create them
 * with their slash commands so the bot posts and schedules everything.
 */
const { guard, access, KINDS: PUNISH_KINDS } = require("../core");

const opt = (values, labels = {}) => values.map((v) => ({ value: v, label: labels[v] ?? v }));
const FILTER_TYPES = ["words", "invites", "links", "spam", "caps", "mentions", "emojis", "newlines", "attachments", "stickers", "zalgo", "names", "massmention"];
const ts = (col) => ({ col, label: "Created", type: "time" });

// Filter changes may need Discord AutoMod rules re-synced.
const filterSync = async (guild) => {
  try {
    await require("../features/filter/automod").syncAll(guild);
  } catch (err) {
    return `Saved, but AutoMod sync failed: ${err.message}`;
  }
  return null;
};

const levelList = (level, kind) => ({
  kind: "list",
  title: `${level === "admin" ? "Admin" : "Moderator"} ${kind === "role" ? "roles" : "users"}`,
  table: "access_levels",
  keys: { level, kind },
  fields: [{ col: "target_id", label: kind === "role" ? "Role" : "Member", type: kind === "role" ? "role" : "member" }],
});

module.exports = [
  // ------------------------------------------------------------ permissions (core/levels.js)
  {
    id: "permissions", title: "Permissions", icon: "🔐", command: "who can run which command",
    sections: [
      {
        kind: "note", title: "How permissions work",
        help:
          "Every member has a level: Member < Moderator < Admin < Owner. The server owner and the bot owner are Owner. " +
          "Administrator / Manage Server holders are Admins and moderation-permission holders are Moderators automatically; " +
          "add more below. Each command needs a level (defaults from its permissions; change them in Command levels). " +
          "Members can't run commands above their level. Discord also hides staff commands from members without " +
          "Manage Messages (moderator commands) or Manage Server (admin commands). To show them to a moderator role " +
          "you add here that lacks those Discord permissions, allow the role under Server Settings → Integrations → the bot.",
      },
      { kind: "oauth", title: "Show staff commands to the roles above (Discord menu sync)" },
      levelList("admin", "role"),
      levelList("admin", "user"),
      levelList("mod", "role"),
      levelList("mod", "user"),
      { kind: "commandLevels", title: "Command levels", help: "Default comes from each command's permissions. Overriding a whole command applies to all its subcommands unless a subcommand has its own setting." },
    ],
  },

  // ------------------------------------------------------------ per-server bot settings (utils/settings.js)
  {
    id: "bot", title: "Bot settings", icon: "🤖", command: "music, colour, command list",
    sections: [
      {
        kind: "config", title: "This server's bot settings",
        help: "Leave a field empty (or \"Default\") to use the bot-wide setting from the Settings tab.",
        fields: [
          { key: "bot_colour", label: "Embed / player colour", type: "colour", optional: true },
          { key: "music_default_volume", label: "Default music volume (%)", type: "int", min: 0, max: 200, optional: true },
          { key: "music_leave_empty", label: "Leave voice when nobody is listening", type: "bool", optional: true },
          { key: "music_leave_empty_ms", label: "…after (e.g. 5m)", type: "duration", optional: true },
          { key: "music_leave_finish", label: "Leave when the queue finishes", type: "bool", optional: true },
          { key: "music_leave_stop", label: "Leave on /stop", type: "bool", optional: true },
          { key: "music_autoplay", label: "Autoplay on by default", type: "bool", optional: true },
          { key: "dj_role", label: "DJ role", type: "role", optional: true },
          { key: "command_list_enabled", label: "Post the command list daily", type: "bool", optional: true },
          { key: "command_list_channel", label: "Command list channel", type: "channel", optional: true },
        ],
      },
    ],
  },

  // ------------------------------------------------------------ server admin
  {
    id: "server-admin",
    title: "Server settings",
    icon: "🛠️",
    command: "/settings, /ignore, /access, /invoke",
    sections: [
      {
        kind: "config", title: "Moderation roles",
        fields: [
          { key: "muted_role", label: "Muted role (text)", type: "role" },
          { key: "imuted_role", label: "Image-muted role", type: "role" },
          { key: "rmuted_role", label: "Reaction-muted role", type: "role" },
          { key: "jail_role", label: "Jail role", type: "role" },
          { key: "jail_strip_roles", label: "Remove a member's roles while jailed", type: "bool" },
          { key: "premium_role", label: "Premium members role", type: "role" },
          { key: "base_role", label: "Booster roles go below", type: "role" },
        ],
      },
      {
        kind: "config", title: "Channels & messages",
        fields: [
          { key: "modlog_channel", label: "Mod log channel", type: "channel" },
          { key: "joinlog_channel", label: "Join / leave log channel", type: "channel" },
          { key: "jail_channel", label: "Jail channel", type: "channel" },
          { key: "jail_message", label: "Jail message", type: "script" },
          { key: "autonick", label: "Nickname given on join (variables work)", type: "text", max: 32 },
        ],
      },
      {
        kind: "list", title: "Staff roles", table: "staff_roles",
        help: "Members with these roles pass \"Staff Only\" checks.",
        fields: [{ col: "role_id", label: "Role", type: "role" }],
      },
      {
        kind: "list", title: "Fake permissions", table: "fake_permissions",
        help: "Bot-only permissions for a role. They never grant Server Owner.",
        fields: [
          { col: "role_id", label: "Role", type: "role" },
          { col: "permission", label: "Permission", type: "select", options: Object.entries(guard.FAKEABLE).map(([label, value]) => ({ value, label })) },
        ],
      },
      {
        kind: "list", title: "Ignored members & channels", table: "ignores",
        fields: [
          { col: "type", label: "Type", type: "select", options: opt(["channel", "member"]) },
          { col: "target_id", label: "Channel or member ID", type: "snowflake" },
        ],
      },
      {
        kind: "list", title: "Disabled commands", table: "disabled_commands",
        help: "Command path such as \"levels rank\" or a whole command \"levels\". Leave channel and member empty to disable everywhere.",
        fields: [
          { col: "command", label: "Command", type: "commandPath" },
          { col: "channel_id", label: "Channel", type: "channel", optional: true, empty: "" },
          { col: "member_id", label: "Member ID", type: "snowflake", optional: true, empty: "" },
        ],
      },
      {
        kind: "list", title: "Disabled modules", table: "disabled_modules",
        fields: [
          { col: "module", label: "Module", type: "module" },
          { col: "channel_id", label: "Channel (empty = everywhere)", type: "channel", optional: true, empty: "" },
        ],
      },
      {
        kind: "list", title: "Disabled bot events", table: "disabled_events",
        fields: [
          { col: "event", label: "Event", type: "select", options: opt(access.EVENTS) },
          { col: "channel_id", label: "Channel (empty = everywhere)", type: "channel", optional: true, empty: "" },
        ],
      },
      {
        kind: "list", title: "Punishment messages (/invoke)", table: "invoke_messages",
        help: "Variables: {user} {moderator} {reason} {duration} {case} {punishment}",
        fields: [
          { col: "punishment", label: "Punishment", type: "select", options: opt(PUNISH_KINDS.filter((k) => k !== "delete")) },
          { col: "target", label: "Send as", type: "select", options: opt(["dm", "channel"], { dm: "DM to the member", channel: "Message in the channel" }) },
          { col: "script", label: "Message", type: "script" },
        ],
      },
      {
        kind: "list", title: "Honeypot channels", table: "server_admin_honeypots",
        help: "Anyone (except staff) who posts here is punished at once. Post a warning in the channel with /antiraid honeypot add.",
        fields: [
          { col: "channel_id", label: "Channel", type: "channel" },
          { col: "punishment", label: "Punishment", type: "select", options: opt(["ban", "kick", "timeout", "jail"]) },
        ],
      },
      {
        kind: "view", title: "Recent cases",
        sql: "SELECT case_id, action, user_id, moderator_id, reason, duration_ms, created_at FROM cases WHERE guild_id = ? ORDER BY case_id DESC LIMIT 200",
        columns: [
          { col: "case_id", label: "#" }, { col: "action", label: "Action" }, { col: "user_id", label: "Member", type: "user" },
          { col: "moderator_id", label: "By", type: "user" }, { col: "reason", label: "Reason" },
          { col: "duration_ms", label: "Duration", type: "duration" }, ts("created_at"),
        ],
      },
    ],
  },

  // ------------------------------------------------------------ filter
  {
    id: "filter", title: "Chat filter", icon: "🧹", command: "/filter",
    sections: [
      {
        kind: "list", title: "Filters", table: "filter_settings", afterSave: filterSync,
        help: "A row with no channel is the server-wide setting; a row with a channel overrides it there. Empty fields fall back to the server-wide value or default.",
        fields: [
          { col: "type", label: "Filter", type: "select", options: opt(FILTER_TYPES) },
          { col: "channel_id", label: "Channel (empty = server-wide)", type: "channel", optional: true, empty: "" },
          { col: "enabled", label: "On", type: "bool", optional: true },
          { col: "threshold", label: "Threshold", type: "int", min: 1, max: 200, optional: true },
          { col: "punishment", label: "Punishment", type: "select", options: opt(["delete", "warn", "timeout", "mute", "jail", "kick", "ban", "points"]), optional: true },
          { col: "duration_ms", label: "Duration (timeout/mute/jail)", type: "duration", optional: true },
        ],
      },
      {
        kind: "list", title: "Words", table: "filter_words", afterSave: filterSync,
        help: "block = blocked word (* wildcards work), allow = never blocked, regex = regular expression.",
        fields: [
          { col: "word", label: "Word / pattern", type: "text", max: 200 },
          { col: "kind", label: "Kind", type: "select", options: opt(["block", "allow", "regex"]) },
        ],
        auto: { added_at: "now", added_by: "panel" },
      },
      { kind: "list", title: "Allowed link domains", table: "filter_urls", fields: [{ col: "host", label: "Domain (e.g. youtube.com)", type: "text", max: 253 }] },
      {
        kind: "list", title: "Exempt roles", table: "filter_exempt", afterSave: filterSync,
        fields: [
          { col: "type", label: "Filter", type: "select", options: opt(FILTER_TYPES) },
          { col: "role_id", label: "Role", type: "role" },
        ],
      },
      {
        kind: "list", title: "Points per filter", table: "filter_points_config",
        help: "Filters whose punishment is \"points\" add this many points per hit.",
        fields: [
          { col: "type", label: "Filter", type: "select", options: opt(FILTER_TYPES) },
          { col: "points", label: "Points", type: "int", min: 1, max: 100 },
        ],
      },
      {
        kind: "list", title: "Points ladder", table: "filter_ladder",
        help: "When a member reaches this many points, apply the punishment. Points decay by 1 per day.",
        fields: [
          { col: "points", label: "At points", type: "int", min: 1, max: 1000 },
          { col: "punishment", label: "Punishment", type: "select", options: opt(["warn", "timeout", "mute", "jail", "kick", "ban"]) },
          { col: "duration_ms", label: "Duration", type: "duration", optional: true },
        ],
      },
      { kind: "config", title: "Points", fields: [{ key: "filter_points_limit", label: "Points cap (0 = none)", type: "int", min: 0, max: 10000 }] },
      {
        kind: "view", title: "Member points", remove: { table: "filter_points", keys: ["user_id"] },
        sql: "SELECT user_id, points, updated_at FROM filter_points WHERE guild_id = ? ORDER BY points DESC LIMIT 200",
        columns: [{ col: "user_id", label: "Member", type: "user" }, { col: "points", label: "Points" }, { col: "updated_at", label: "Last hit", type: "time" }],
      },
    ],
  },

  // ------------------------------------------------------------ config
  {
    id: "config", title: "Welcome, sticky & gallery", icon: "👋", command: "/config",
    sections: [
      {
        kind: "list", title: "Welcome / goodbye / boost messages", table: "config_join_messages",
        fields: [
          { col: "kind", label: "When", type: "select", options: opt(["welcome", "goodbye", "boost"]) },
          { col: "channel_id", label: "Channel", type: "channel" },
          { col: "script", label: "Message", type: "script" },
          { col: "self_destruct", label: "Delete after (seconds)", type: "int", min: 1, max: 86400, optional: true },
          { col: "pingable", label: "Ping the member", type: "bool" },
        ],
        auto: { created_at: "now" },
      },
      {
        kind: "list", title: "Sticky messages", table: "config_sticky_messages",
        help: "Re-posted at the bottom of the channel after people talk.",
        fields: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "script", label: "Message", type: "script" }],
        auto: { created_at: "now" },
      },
      {
        kind: "list", title: "Image-only channels", table: "config_gallery_channels",
        fields: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "thread", label: "Open a thread for each post", type: "bool" }],
      },
      {
        kind: "view", title: "Command aliases (create with /config alias add)",
        sql: "SELECT shortcut, command, created_at FROM config_aliases WHERE guild_id = ? ORDER BY shortcut",
        columns: [{ col: "shortcut", label: "Shortcut" }, { col: "command", label: "Runs" }, ts("created_at")],
      },
      {
        kind: "view", title: "Webhooks (create with /config webhook)",
        sql: "SELECT identifier, name, channel_id, locked, created_at FROM config_webhooks WHERE guild_id = ? ORDER BY identifier",
        columns: [{ col: "identifier", label: "ID" }, { col: "name", label: "Name" }, { col: "channel_id", label: "Channel", type: "channel" }, { col: "locked", label: "Locked", type: "bool" }, ts("created_at")],
      },
    ],
  },

  // ------------------------------------------------------------ booster roles
  {
    id: "boosterrole", title: "Booster roles & badge", icon: "💎", command: "/boosterrole, /badge",
    sections: [
      {
        kind: "row", title: "Booster roles", table: "boosterrole_settings",
        fields: [
          { col: "award_role_id", label: "Role given to every booster", type: "role", optional: true },
          { col: "share_limit", label: "Max members a booster can share their role with (0 = no limit)", type: "int", min: 0, max: 100, optional: true },
          { col: "share_max", label: "Max shared roles one member can hold (0 = no limit)", type: "int", min: 0, max: 100, optional: true },
          { col: "role_limit", label: "Max booster roles in the server (0 = no limit)", type: "int", min: 0, max: 250, optional: true },
        ],
      },
      { kind: "list", title: "Blocked words in role names", table: "boosterrole_filter", fields: [{ col: "word", label: "Word", type: "text", max: 100 }] },
      {
        kind: "view", title: "Booster roles", remove: null,
        sql: "SELECT owner_id, role_id, created_at FROM boosterrole_roles WHERE guild_id = ? ORDER BY created_at DESC",
        columns: [{ col: "owner_id", label: "Booster", type: "user" }, { col: "role_id", label: "Role", type: "role" }, ts("created_at")],
      },
      {
        kind: "row", title: "Server tag badge", table: "boosterrole_badge_settings",
        help: "Rewards members who wear this server's tag.",
        fields: [
          { col: "enabled", label: "On", type: "bool" },
          { col: "channel_id", label: "Announce in", type: "channel", optional: true },
          { col: "script", label: "Award message ({tag} works)", type: "script", optional: true },
        ],
      },
      { kind: "list", title: "Badge reward roles", table: "boosterrole_badge_roles", fields: [{ col: "role_id", label: "Role", type: "role", assignable: true }] },
    ],
  },

  // ------------------------------------------------------------ suggest
  {
    id: "suggest", title: "Suggestions", icon: "💡", command: "/suggest",
    sections: [
      {
        kind: "row", title: "Settings", table: "suggest_settings",
        fields: [
          { col: "channel_id", label: "Suggestions channel", type: "channel", optional: true },
          { col: "review_enabled", label: "Staff review before posting", type: "bool" },
          { col: "review_channel_id", label: "Review channel", type: "channel", optional: true },
          { col: "locked", label: "Locked (no new suggestions)", type: "bool" },
          { col: "upvote", label: "Upvote emoji", type: "emoji", optional: true },
          { col: "downvote", label: "Downvote emoji", type: "emoji", optional: true },
          { col: "threads", label: "Open a discussion thread", type: "bool" },
        ],
      },
      {
        kind: "list", title: "Blocked from suggesting", table: "suggest_ignores",
        fields: [{ col: "kind", label: "Type", type: "select", options: opt(["member", "role"]) }, { col: "target_id", label: "Member or role ID", type: "snowflake" }],
      },
      {
        kind: "view", title: "Suggestions",
        sql: "SELECT id, status, author_name, content, created_at FROM suggest_items WHERE guild_id = ? ORDER BY id DESC LIMIT 200",
        columns: [{ col: "id", label: "#" }, { col: "status", label: "Status" }, { col: "author_name", label: "By" }, { col: "content", label: "Suggestion" }, ts("created_at")],
      },
    ],
  },

  // ------------------------------------------------------------ autoresponder
  {
    id: "autoresponder", title: "Autoresponders & reactions", icon: "💬", command: "/autoresponder, /reaction",
    sections: [
      {
        kind: "list", title: "Autoresponders", table: "autoresponder_triggers",
        help: "Trigger matching: whole word by default; hi* = starts with, *bye = ends with, *lol* = contains.",
        fields: [
          { col: "trigger", label: "Trigger", type: "text", max: 100, lower: true },
          { col: "script", label: "Reply", type: "script" },
          { col: "strict", label: "Whole message must match", type: "bool" },
          { col: "reply", label: "Reply to the message", type: "bool" },
          { col: "delete_message", label: "Delete the trigger message", type: "bool" },
          { col: "ignore_command_check", label: "Also fire on commands", type: "bool" },
          { col: "self_destruct", label: "Delete reply after (seconds)", type: "int", min: 1, max: 86400, optional: true },
        ],
        auto: { created_at: "now", creator_id: "panel" },
      },
      {
        kind: "list", title: "Autoresponder roles", table: "autoresponder_roles",
        fields: [
          { col: "trigger", label: "Trigger", type: "text", max: 100, lower: true },
          { col: "role_id", label: "Role", type: "role", assignable: true },
          { col: "action", label: "Action", type: "select", options: opt(["add", "remove"]) },
        ],
      },
      {
        kind: "view", title: "Reaction triggers (add with /reaction add)", remove: { table: "autoresponder_reactions", keys: ["kind", "trigger", "emoji_key"] },
        sql: "SELECT kind, trigger, emoji, emoji_key FROM autoresponder_reactions WHERE guild_id = ? ORDER BY trigger",
        columns: [{ col: "kind", label: "Kind" }, { col: "trigger", label: "Trigger" }, { col: "emoji", label: "Emoji", type: "emoji" }],
      },
      {
        kind: "view", title: "Channel auto-reactions (add with /reaction messages add)", remove: { table: "autoresponder_channel_reactions", keys: ["channel_id"] },
        sql: "SELECT channel_id, emojis FROM autoresponder_channel_reactions WHERE guild_id = ?",
        columns: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "emojis", label: "Emojis", type: "emojiList" }],
      },
      {
        kind: "row", title: "No self-react", table: "autoresponder_noselfreact",
        fields: [
          { col: "enabled", label: "On", type: "bool" },
          { col: "bypass_staff", label: "Staff are exempt", type: "bool" },
          { col: "punishment", label: "Punishment", type: "select", options: opt(["none", "warn", "timeout", "rmute", "kick"]) },
        ],
      },
    ],
  },

  // ------------------------------------------------------------ automation
  {
    id: "automation", title: "Automation", icon: "⚙️", command: "/automation",
    sections: [
      { kind: "list", title: "Auto-publish channels (announcement channels)", table: "automation_publisher_channels", fields: [{ col: "channel_id", label: "Channel", type: "channel" }] },
      { kind: "config", title: "Timers", fields: [{ key: "automation_timer_activity", label: "Only post timers after someone has talked", type: "bool" }] },
      {
        kind: "view", title: "Timers (create with /automation timer add)", remove: { table: "automation_timers", keys: ["channel_id"] },
        sql: "SELECT channel_id, interval_ms, last_post_at, script FROM automation_timers WHERE guild_id = ?",
        columns: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "interval_ms", label: "Every", type: "duration" }, { col: "last_post_at", label: "Last post", type: "time" }, { col: "script", label: "Message", type: "clip" }],
      },
      {
        kind: "view", title: "Counters (create with /automation counter add)", remove: { table: "automation_counters", keys: ["channel_id"] },
        sql: "SELECT channel_id, option, name_template, last_name FROM automation_counters WHERE guild_id = ?",
        columns: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "option", label: "Counts" }, { col: "last_name", label: "Current name" }],
      },
      {
        kind: "view", title: "Leaderboards (create with /automation leaderboard)", remove: { table: "automation_leaderboards", keys: ["kind", "timeframe"] },
        sql: "SELECT kind, timeframe, channel_id FROM automation_leaderboards WHERE guild_id = ?",
        columns: [{ col: "kind", label: "Kind" }, { col: "timeframe", label: "Timeframe" }, { col: "channel_id", label: "Channel", type: "channel" }],
      },
    ],
  },

  // ------------------------------------------------------------ autorole
  {
    id: "autorole", title: "Auto roles", icon: "🎭", command: "/autorole",
    sections: [
      { kind: "list", title: "Roles given on join", table: "autorole_join", fields: [{ col: "role_id", label: "Role", type: "role", assignable: true }] },
      { kind: "config", title: "Reaction roles", fields: [{ key: "autorole_reaction_restore", label: "Give reaction roles back when a member rejoins", type: "bool" }] },
      {
        kind: "view", title: "Reaction roles",
        help: "Every reaction role the bot handles. Menus built in the Reaction roles tab (colours, icons) are edited there; the others with /autorole reactionrole.",
        sql: `SELECT r.channel_id, r.message_id, r.emoji, r.role_id,
                CASE WHEN g.managed_by = 'panel' THEN 'Reaction roles tab' ELSE '/autorole' END AS source,
                CASE WHEN g.exclusive THEN 'one per group' ELSE '' END AS mode
              FROM autorole_reaction r LEFT JOIN autorole_reaction_group g ON g.message_id = r.message_id
              WHERE r.guild_id = ? ORDER BY source DESC, r.message_id`,
        columns: [{ col: "source", label: "Edited in" }, { col: "channel_id", label: "Channel", type: "channel" }, { col: "message_id", label: "Message", type: "message" }, { col: "emoji", label: "Emoji", type: "emoji" }, { col: "role_id", label: "Role", type: "role" }, { col: "mode", label: "Mode" }],
      },
      {
        kind: "view", title: "Button roles (set up with /autorole buttonrole)",
        sql: "SELECT channel_id, message_id, label, emoji, role_id FROM autorole_button WHERE guild_id = ? ORDER BY message_id, idx",
        columns: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "message_id", label: "Message", type: "message" }, { col: "label", label: "Label" }, { col: "emoji", label: "Emoji", type: "emoji" }, { col: "role_id", label: "Role", type: "role" }],
      },
      {
        kind: "view", title: "Dropdown roles (set up with /autorole dropdownrole)",
        sql: "SELECT d.channel_id, d.message_id, o.title, o.role_id FROM autorole_dropdown d JOIN autorole_dropdown_option o USING (message_id) WHERE d.guild_id = ? ORDER BY d.message_id, o.idx",
        columns: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "message_id", label: "Message", type: "message" }, { col: "title", label: "Option" }, { col: "role_id", label: "Role", type: "role" }],
      },
    ],
  },

  // ------------------------------------------------------------ voicemaster
  {
    id: "voicemaster", title: "VoiceMaster", icon: "🔊", command: "/voicemaster",
    sections: [
      {
        kind: "row", title: "Temporary voice channels", table: "voicemaster_config",
        help: "Run /voicemaster setup once to create the join channel and categories.",
        fields: [
          { col: "hub_channel_id", label: "Join-to-create channel", type: "voice", optional: true },
          { col: "default_name", label: "Default channel name ({user.display_name} works)", type: "text", max: 100, optional: true },
          { col: "default_region", label: "Default region", type: "select", optional: true, options: opt(["brazil", "hongkong", "india", "japan", "rotterdam", "singapore", "south-korea", "southafrica", "sydney", "us-central", "us-east", "us-south", "us-west"]) },
          { col: "default_bitrate", label: "Default bitrate (kbps)", type: "int", min: 8, max: 384, optional: true },
          { col: "default_interface", label: "Post the control panel in each new channel", type: "bool" },
          { col: "join_role_id", label: "Role given while in a temp channel", type: "role", optional: true, assignable: true },
          { col: "default_role_id", label: "Role whose permissions new channels copy (empty = @everyone)", type: "role", optional: true },
        ],
      },
      {
        kind: "view", title: "Active temporary channels",
        sql: "SELECT channel_id, owner_id, locked, ghosted, created_at FROM voicemaster_channels WHERE guild_id = ?",
        columns: [{ col: "channel_id", label: "Channel", type: "channel" }, { col: "owner_id", label: "Owner", type: "user" }, { col: "locked", label: "Locked", type: "bool" }, { col: "ghosted", label: "Hidden", type: "bool" }, ts("created_at")],
      },
    ],
  },

  // ------------------------------------------------------------ levels
  {
    id: "levels", title: "Levels", icon: "📈", command: "/levels",
    sections: [
      {
        kind: "row", title: "Levelling", table: "levels_config",
        fields: [
          { col: "enabled", label: "Levelling on", type: "bool" },
          { col: "multiplier", label: "XP rate (0.25–3)", type: "number", min: 0.25, max: 3 },
          { col: "stack_roles", label: "Keep lower level roles (stack)", type: "bool" },
          { col: "message_mode", label: "Level-up message", type: "select", options: opt(["here", "channel", "dm", "off"], { here: "In the channel they talked in", channel: "In one channel", dm: "By DM", off: "Off" }) },
          { col: "message_channel_id", label: "Level-up channel", type: "channel", optional: true },
          { col: "script", label: "Level-up message ({level} {xp} {next_level} {rank} {role})", type: "script", optional: true },
          { col: "leaderboard_title", label: "Leaderboard title", type: "text", max: 200, optional: true },
        ],
      },
      {
        kind: "list", title: "Level roles", table: "levels_roles",
        fields: [{ col: "level", label: "At level", type: "int", min: 1, max: 1000 }, { col: "role_id", label: "Role", type: "role", assignable: true }],
      },
      {
        kind: "list", title: "No XP in / for", table: "levels_ignores",
        fields: [{ col: "kind", label: "Type", type: "select", options: opt(["channel", "role"]) }, { col: "target_id", label: "Channel or role ID", type: "snowflake" }],
      },
      {
        kind: "view", title: "Leaderboard",
        sql: "SELECT user_id, level, xp FROM levels_members WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC LIMIT 100",
        columns: [{ col: "user_id", label: "Member", type: "user" }, { col: "level", label: "Level" }, { col: "xp", label: "XP" }],
      },
    ],
  },

  // ------------------------------------------------------------ giveaways
  {
    id: "giveaways", title: "Giveaways", icon: "🎉", command: "/giveaways",
    sections: [
      {
        kind: "view", title: "Giveaways (start with /giveaways start)",
        sql: `SELECT g.id, g.prize, g.channel_id, g.winners, g.ends_at,
                CASE WHEN g.cancelled THEN 'cancelled' WHEN g.ended THEN 'ended' ELSE 'running' END AS state,
                (SELECT COUNT(*) FROM giveaways_entries e WHERE e.giveaway_id = g.id) AS entries
              FROM giveaways g WHERE g.guild_id = ? ORDER BY g.id DESC LIMIT 100`,
        columns: [{ col: "id", label: "#" }, { col: "prize", label: "Prize" }, { col: "state", label: "State" }, { col: "entries", label: "Entries" }, { col: "winners", label: "Winners" }, { col: "channel_id", label: "Channel", type: "channel" }, { col: "ends_at", label: "Ends", type: "time" }],
      },
    ],
  },

  // ------------------------------------------------------------ boards
  ...["starboard", "clownboard"].map((kind) => ({
    id: kind, title: kind === "starboard" ? "Starboard" : "Clownboard", icon: kind === "starboard" ? "⭐" : "🤡", command: `/${kind}`,
    sections: [
      {
        kind: "row", title: "Settings", table: "boards", keys: { kind },
        help: "Empty fields use the defaults.",
        fields: [
          { col: "channel_id", label: "Board channel", type: "channel", optional: true },
          { col: "emoji", label: "Emoji", type: "emoji", optional: true },
          { col: "threshold", label: "Reactions needed", type: "int", min: 1, max: 500, optional: true },
          { col: "color", label: "Embed colour", type: "colour", optional: true },
          { col: "selfstar", label: "Count the author's own reaction", type: "bool", optional: true },
          { col: "attachments", label: "Show attachments", type: "bool", optional: true },
          { col: "jumpurl", label: "Show jump link", type: "bool", optional: true },
          { col: "timestamp", label: "Show timestamp", type: "bool", optional: true },
          { col: "locked", label: "Locked (paused)", type: "bool" },
        ],
      },
      {
        kind: "list", title: "Ignored", table: "board_ignores", keys: { kind },
        fields: [{ col: "target_kind", label: "Type", type: "select", options: opt(["channel", "member", "role"]) }, { col: "target_id", label: "Channel, member or role ID", type: "snowflake" }],
      },
    ],
  })),

  // ------------------------------------------------------------ bumpreminder
  {
    id: "bumpreminder", title: "Bump reminder", icon: "⏰", command: "/bumpreminder",
    sections: [
      {
        kind: "row", title: "DISBOARD bump reminder", table: "bumpreminder",
        fields: [
          { col: "enabled", label: "On", type: "bool" },
          { col: "channel_id", label: "Bump channel", type: "channel", optional: true },
          { col: "reminder_script", label: "Reminder message (empty = default)", type: "script", optional: true },
          { col: "pingable", label: "Allow pings in the reminder", type: "bool" },
          { col: "thankyou_script", label: "Thank-you message ({user} {next_bump})", type: "script", optional: true },
          { col: "autolock", label: "Lock the channel until the next bump", type: "bool" },
          { col: "autoclean", label: "Delete other messages in the channel", type: "bool" },
          { col: "next_bump_at", label: "Next bump", type: "readonly", format: "time" },
        ],
      },
    ],
  },
];
