/**
 * /config webhook create|lock|unlock|send|edit|delete|list
 *
 * Webhooks are created by the bot in a channel and stored with a short
 * identifier. Their token is encrypted at rest and never displayed: members
 * use them through /config webhook send, so the token can't leak.
 * Locked webhooks can only be used (send/edit/delete) by their creator and
 * administrators.
 */
const { ChannelType, MessageFlags, PermissionFlagsBits: P, WebhookClient } = require("discord.js");
const { guard, parse, script, ui, UserError } = require("../../../core");
const store = require("../db");
const { encrypt, decrypt, newIdentifier } = require("../lib");
const { askModal } = require("./modal");

const WEBHOOK_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia];

/** Secret for token encryption: WEBHOOK_SECRET, else the bot token. */
const secretOf = (client) => process.env.WEBHOOK_SECRET || client.token;

function findOrThrow(guildId, identifier) {
  const row = store.webhooks.get(guildId, String(identifier ?? "").trim().toLowerCase());
  if (!row) throw new UserError(`There's no webhook \`${identifier}\`. See \`/config webhook list\`.`);
  return row;
}

/** Locked webhooks: creator and admins only. */
function assertCanUse(ctx, row) {
  if (row.locked && row.creator_id !== ctx.user.id && !guard.isAdmin(ctx.member))
    throw new UserError(`Webhook \`${row.identifier}\` is locked; only <@${row.creator_id}> and administrators can use it.`);
}

/** A WebhookClient for a stored row. Re-fetches the token from Discord if it can't be decrypted. */
async function clientFor(client, row) {
  let token = decrypt(row.webhook_token_encrypted, secretOf(client));
  if (!token) {
    const hook = await client.fetchWebhook(row.webhook_id).catch(() => null);
    if (!hook) {
      store.webhooks.remove(row.guild_id, row.identifier);
      throw new UserError(`Webhook \`${row.identifier}\` no longer exists on Discord, so I removed it from the list.`);
    }
    if (!hook.token) throw new UserError(`I can't use webhook \`${row.identifier}\` any more. Delete it and create a new one.`);
    token = hook.token;
    store.webhooks.setToken(row.guild_id, row.identifier, encrypt(token, secretOf(client)));
  }
  return new WebhookClient({ id: row.webhook_id, token });
}

/** Turns "Unknown Webhook" into a cleanup + readable error. */
async function withWebhook(ctx, row, fn) {
  const hook = await clientFor(ctx.client, row);
  try {
    return await fn(hook);
  } catch (err) {
    if (err?.code === 10015) {
      store.webhooks.remove(row.guild_id, row.identifier);
      throw new UserError(`Webhook \`${row.identifier}\` was deleted on Discord, so I removed it from the list.`);
    }
    throw err;
  } finally {
    hook.destroy();
  }
}

/** Builds a stored script from the send/edit modal fields. */
function scriptFromForm(values) {
  const content = values.content;
  if (script.looksLikeJson(content)) return script.validate(content);
  const embed = {};
  if (values.title) embed.title = values.title;
  if (values.description) embed.description = values.description;
  if (!Object.keys(embed).length) {
    if (!content) throw new UserError("The message is empty.");
    return script.validate(content);
  }
  return script.validate(JSON.stringify(content ? { content, embed } : { embed }));
}

const handlers = {
  create: {
    gate: "Manage Webhooks",
    async run(interaction, ctx) {
      const channel = ctx.channel;
      if (!WEBHOOK_CHANNELS.includes(channel?.type) || channel.isThread?.())
        throw new UserError("Webhooks can only be created in text, announcement, voice, stage or forum channels (not threads).");
      guard.assertBotPermissions(channel, [P.ManageWebhooks]);
      const name = (ctx.options.getString("name") ?? ctx.guild.name).trim().slice(0, 80);
      if (/clyde|discord/i.test(name)) throw new UserError("Discord doesn't allow webhook names containing \"clyde\" or \"discord\".");

      const hook = await channel.createWebhook({ name, avatar: ctx.guild.iconURL({ size: 256 }) ?? undefined, reason: `/config webhook create by ${ctx.user.tag}` });
      let identifier = newIdentifier();
      while (store.webhooks.exists(ctx.guild.id, identifier)) identifier = newIdentifier();
      store.webhooks.add({
        guildId: ctx.guild.id, identifier, webhookId: hook.id, token: encrypt(hook.token, secretOf(ctx.client)),
        channelId: channel.id, name, creatorId: ctx.user.id,
      });
      await ctx.success(`Created webhook **${name}** in ${channel} with identifier \`${identifier}\`.\nSend with \`/config webhook send identifier:${identifier}\`. Lock it with \`/config webhook lock\` so only you can use it.`);
    },
  },

  lock: lockHandler(true),
  unlock: lockHandler(false),

  send: {
    gate: "Manage Webhooks",
    defer: false, // opens a modal
    async run(interaction, ctx) {
      const row = findOrThrow(ctx.guild.id, ctx.options.getString("identifier", true));
      assertCanUse(ctx, row);
      const form = await askModal(interaction, {
        title: `Send as ${row.name}`,
        fields: [
          { id: "username", label: "Username (optional)", value: "", placeholder: row.name, max: 80 },
          { id: "avatar", label: "Avatar URL (optional)", placeholder: "https://...", max: 500 },
          { id: "content", label: "Message (plain text, or full JSON script)", paragraph: true, placeholder: "Hello {guild.name}!" },
          { id: "title", label: "Embed title", max: 256, placeholder: "Optional" },
          { id: "description", label: "Embed description", paragraph: true, placeholder: "Optional" },
        ],
      });
      if (!form) return;
      ctx.target = form.submit;
      await form.submit.deferReply({ flags: MessageFlags.Ephemeral });

      const { username, avatar } = form.values;
      if (username && /clyde|discord/i.test(username)) throw new UserError("Webhook usernames can't contain \"clyde\" or \"discord\".");
      if (avatar && !/^https?:\/\/\S+$/i.test(avatar)) throw new UserError("The avatar must be an http(s) URL.");
      const stored = scriptFromForm(form.values);
      const payload = script.render(stored, { member: ctx.member, guild: ctx.guild, channel: ctx.channel });

      const message = await withWebhook(ctx, row, (hook) =>
        hook.send({ ...payload, username: username || undefined, avatarURL: avatar || undefined }));
      const link = `https://discord.com/channels/${ctx.guild.id}/${message.channel_id ?? row.channel_id}/${message.id}`;
      await ctx.success(`Sent through \`${row.identifier}\` in <#${row.channel_id}>: ${link}`);
    },
  },

  edit: {
    gate: "Manage Webhooks",
    defer: false, // opens a modal
    async run(interaction, ctx) {
      const ref = parse.messageLink(ctx.options.getString("message_link", true));
      if (ref.guildId && ref.guildId !== ctx.guild.id) throw new UserError("That message is in a different server.");
      // Fetch the message for the pre-filled modal, but never risk the 3 s modal deadline.
      const channel = ref.channelId ? ctx.guild.channels.cache.get(ref.channelId) : ctx.channel;
      if (!channel?.isTextBased?.()) throw new UserError("I can't find the channel of that message.");
      const message = await Promise.race([
        channel.messages.fetch(ref.messageId).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
      ]);
      if (message === null) throw new UserError("I can't find that message (or can't read that channel).");
      if (message && !message.webhookId) throw new UserError("That message wasn't sent by a webhook.");
      const row = message ? store.webhooks.byWebhookId(ctx.guild.id, message.webhookId) : null;
      if (message && !row) throw new UserError("That message was sent by a webhook I don't manage. Only webhooks from `/config webhook create` can be edited.");
      if (row) assertCanUse(ctx, row);

      const first = message?.embeds?.[0];
      const form = await askModal(interaction, {
        title: "Edit webhook message",
        fields: [
          { id: "content", label: "Message (plain text, or full JSON script)", paragraph: true, value: message?.content ?? "" },
          { id: "title", label: "Embed title", max: 256, value: first?.title ?? "" },
          { id: "description", label: "Embed description", paragraph: true, value: first?.description ?? "" },
        ],
      });
      if (!form) return;
      ctx.target = form.submit;
      await form.submit.deferReply({ flags: MessageFlags.Ephemeral });

      // Slow path: the fetch didn't finish before the modal; check now.
      let target = message;
      let hookRow = row;
      if (!target) {
        target = await channel.messages.fetch(ref.messageId).catch(() => null);
        if (!target) throw new UserError("I can't find that message (or can't read that channel).");
        hookRow = target.webhookId ? store.webhooks.byWebhookId(ctx.guild.id, target.webhookId) : null;
        if (!hookRow) throw new UserError("That message wasn't sent by one of my webhooks.");
        assertCanUse(ctx, hookRow);
      }

      const stored = scriptFromForm(form.values);
      const payload = script.render(stored, { member: ctx.member, guild: ctx.guild, channel });
      await withWebhook(ctx, hookRow, (hook) =>
        hook.editMessage(target.id, { ...payload, threadId: channel.isThread?.() ? channel.id : undefined }));
      await ctx.success(`Edited ${target.url}.`);
    },
  },

  delete: {
    gate: "Manage Webhooks",
    async run(interaction, ctx) {
      const row = findOrThrow(ctx.guild.id, ctx.options.getString("identifier", true));
      assertCanUse(ctx, row);
      // Delete on Discord with the bot's own permission (works even if the token is unreadable).
      await ctx.client.deleteWebhook(row.webhook_id, { reason: `/config webhook delete by ${ctx.user.tag}` }).catch((err) => {
        if (err?.code !== 10015) throw err; // already gone is fine
      });
      store.webhooks.remove(ctx.guild.id, row.identifier);
      await ctx.success(`Deleted webhook **${row.name}** (\`${row.identifier}\`).`);
    },
  },

  list: {
    // Public: shows names, channels and creators, never tokens or webhook IDs.
    async run(interaction, ctx) {
      const lines = store.webhooks.list(ctx.guild.id).map((r) =>
        `\`${r.identifier}\` **${r.name}** in <#${r.channel_id}> by <@${r.creator_id}>${r.locked ? " 🔒" : ""}`);
      await ui.paginate(interaction, ui.listPages(ctx.client, "Webhooks", lines, { empty: "No webhooks yet. Create one with `/config webhook create`." }));
    },
  },
};

function lockHandler(locked) {
  return {
    gate: "Manage Webhooks",
    async run(interaction, ctx) {
      const row = findOrThrow(ctx.guild.id, ctx.options.getString("identifier", true));
      if (row.creator_id !== ctx.user.id && !guard.isAdmin(ctx.member))
        throw new UserError(`Only <@${row.creator_id}> (the creator) or an administrator can ${locked ? "lock" : "unlock"} this webhook.`);
      if (Boolean(row.locked) === locked) throw new UserError(`\`${row.identifier}\` is already ${locked ? "locked" : "unlocked"}.`);
      store.webhooks.setLocked(ctx.guild.id, row.identifier, locked);
      await ctx.success(locked
        ? `Locked \`${row.identifier}\`: only <@${row.creator_id}> and administrators can send, edit or delete with it.`
        : `Unlocked \`${row.identifier}\`: anyone with Manage Webhooks can use it.`);
    },
  };
}

/** Autocomplete for `identifier`: identifier + name. */
const autocomplete = (interaction, ctx) =>
  store.webhooks.list(ctx.guild.id).map((r) => ({ name: `${r.identifier} - ${r.name}`, value: r.identifier }));

module.exports = { handlers, autocomplete, scriptFromForm };
