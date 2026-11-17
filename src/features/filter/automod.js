/**
 * Mirrors some filters into Discord AutoMod, so Discord blocks the message
 * before it is even posted (and it keeps working if the bot is offline).
 *
 * Mirrored kinds: words (keyword rule: block list, regex, allow list),
 * invites (keyword rule with an invite regex) and mentions (MENTION_SPAM rule).
 * Everything else, and every per-channel override, is enforced by the bot's
 * own listener (listeners.js).
 *
 * A kind is mirrored only while its server default is enabled AND its
 * punishment is one AutoMod can do itself (delete -> block, timeout -> block +
 * timeout). For points / warn / mute / jail / kick / ban the bot must see the
 * message to punish it, so the bot-owned AutoMod rule is removed and the
 * listener does the work instead. Channels with a per-channel override are
 * exempted from the AutoMod rule for the same reason.
 *
 * One bot-owned rule per kind; its id is kept in filter_automod_rules.
 */
const {
  PermissionFlagsBits,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
} = require("discord.js");
const store = require("./db");
const { settingFor } = require("./match");
const { AUTOMOD_TYPES, AUTOMOD_PUNISHMENTS } = require("./constants");

// Rust regex syntax (what AutoMod uses); same meaning as match.js INVITE.
const INVITE_PATTERN = "(?:discord(?:app)?\\.com/invite|discord\\.(?:gg|io|me|li)|dsc\\.gg)/[a-zA-Z0-9-]+";
const MAX_TIMEOUT_S = 28 * 86400;

/**
 * The AutoMod rule a kind should have, or null when it shouldn't be mirrored.
 * Pure: takes the compiled guild rules and the staff role ids.
 */
function desiredRule(compiled, type, staffRoleIds = []) {
  if (!AUTOMOD_TYPES.includes(type)) return null;
  const setting = settingFor(compiled, type, []); // server default only
  if (!setting || !AUTOMOD_PUNISHMENTS.has(setting.punishment)) return null;

  const t = compiled.types.get(type);
  const exemptChannels = [...(t?.channels.keys() ?? [])].slice(0, 50);
  const exemptRoles = [...new Set([...(compiled.exempt.get(type) ?? []), ...staffRoleIds])].slice(0, 20);

  const actions = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: `Your message was blocked by this server's ${type} filter.` } }];
  if (setting.punishment === "timeout") {
    const seconds = Math.round((setting.durationMs ?? 600e3) / 1000);
    actions.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: Math.min(Math.max(seconds, 60), MAX_TIMEOUT_S) } });
  }

  const base = {
    name: `Bot filter: ${type}`,
    eventType: AutoModerationRuleEventType.MessageSend,
    enabled: true,
    actions,
    exemptRoles,
    exemptChannels,
  };

  if (type === "words") {
    const { block, allow, regex } = compiled.words.lists;
    if (!block.length && !regex.length) return null; // nothing to mirror
    return {
      ...base,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { keywordFilter: block.slice(0, 1000), regexPatterns: regex.slice(0, 10), allowList: allow.slice(0, 100) },
    };
  }
  if (type === "invites") {
    return { ...base, triggerType: AutoModerationRuleTriggerType.Keyword, triggerMetadata: { keywordFilter: [], regexPatterns: [INVITE_PATTERN], allowList: [] } };
  }
  // mentions
  return {
    ...base,
    triggerType: AutoModerationRuleTriggerType.MentionSpam,
    triggerMetadata: { mentionTotalLimit: Math.min(Math.max(setting.threshold ?? 5, 1), 50), mentionRaidProtectionEnabled: false },
  };
}

/**
 * Creates, updates or removes the bot-owned AutoMod rule for `type`.
 * Never throws: returns a short status line for the command reply, or null
 * when nothing happened.
 */
async function sync(guild, type) {
  if (!AUTOMOD_TYPES.includes(type)) return null;
  const desired = desiredRule(store.rules.get(guild.id), type, store.staffRoles(guild.id));
  const ruleId = store.getAutomodRule(guild.id, type);
  if (!desired && !ruleId) return null;
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild))
    return "AutoMod wasn't updated: I need the **Manage Server** permission for that.";

  try {
    let rule = null;
    if (ruleId) {
      rule = await guild.autoModerationRules.fetch({ autoModerationRule: ruleId, force: true }).catch((err) => {
        if (err.code === 10066) return null; // deleted by someone in Server Settings
        throw err;
      });
    }

    if (!desired) {
      if (rule) await rule.delete("Filter disabled or handled by the bot");
      store.setAutomodRule(guild.id, type, null);
      return rule ? `Removed the AutoMod rule for **${type}** (the bot handles it now).` : null;
    }

    if (rule) {
      const { triggerType, ...editable } = desired;
      void triggerType; // can't be changed on an existing rule
      await rule.edit({ ...editable, reason: "Filter settings changed" });
    } else {
      rule = await guild.autoModerationRules.create({ ...desired, reason: "Filter mirrored to AutoMod" });
      store.setAutomodRule(guild.id, type, rule.id);
    }
    return `AutoMod rule **${rule.name}** is in sync.`;
  } catch (err) {
    console.warn(`[filter] AutoMod sync ${type} in ${guild.name}: ${err.message}`);
    return `Couldn't update AutoMod for **${type}**: ${err.message}`;
  }
}

/** Syncs every mirrored kind; returns the non-empty status lines. */
async function syncAll(guild) {
  const lines = [];
  for (const type of AUTOMOD_TYPES) {
    const line = await sync(guild, type);
    if (line) lines.push(line);
  }
  return lines;
}

module.exports = { desiredRule, sync, syncAll, INVITE_PATTERN };
