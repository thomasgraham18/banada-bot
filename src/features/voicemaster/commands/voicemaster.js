/**
 * /voicemaster: join-to-create temporary voice channels (Bleed's VoiceMaster).
 *
 * Tree (23 top-level entries, 28 subcommands):
 *   join role · default role|name|region|bitrate|interface · category public|private
 *   setup · sendinterface · reset · clear · config            (server settings)
 *   lock · unlock · ghost · unghost · name · status · limit · bitrate · music · role
 *   permit · reject · claim · transfer · info                  (your own channel)
 *
 * Channel subcommands act on the VoiceMaster channel you are in and check the
 * stored owner (service.currentChannel), not Discord permissions.
 */
const { SlashCommandBuilder, ChannelType, InteractionContextType, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, embeds, ensure, guard, ui, UserError } = require("../../../core");
const store = require("../db");
const service = require("../service");
const logic = require("../logic");

const MAX_KBPS = 384; // boost level 3; the real cap is checked against the guild at runtime

// ---------------------------------------------------------------- builder

const sub = (b, name, description, extra = (s) => s) => b.addSubcommand((s) => extra(s.setName(name).setDescription(description)));
const categoryOption = (s) =>
  s.addChannelOption((o) => o.setName("category").setDescription("A category").setRequired(true).addChannelTypes(ChannelType.GuildCategory));
const kbpsOption = (s) =>
  s.addIntegerOption((o) => o.setName("kbps").setDescription("Bitrate in kbps (8-96, up to 384 with boosts)").setRequired(true).setMinValue(8).setMaxValue(MAX_KBPS));
const roleOption = (description) => (s) => s.addRoleOption((o) => o.setName("role").setDescription(description).setRequired(true));
const settingOption = (description) => (s) => s.addBooleanOption((o) => o.setName("setting").setDescription(description).setRequired(true));

const data = new SlashCommandBuilder()
  .setName("voicemaster")
  .setDescription("Join-to-create temporary voice channels")
  .setContexts(InteractionContextType.Guild)
  .addSubcommandGroup((g) =>
    g.setName("join").setDescription("Join settings")
      .addSubcommand((s) => roleOption("Role held while in a VoiceMaster channel")(s.setName("role").setDescription("Set a role that members get for being in a VM channel")))
  )
  .addSubcommandGroup((g) =>
    g.setName("default").setDescription("Defaults for new voice channels")
      .addSubcommand((s) => roleOption("Role that lock/ghost/music change (default @everyone)")(s.setName("role").setDescription("Set the role whose permissions lock and ghost change")))
      .addSubcommand((s) =>
        s.setName("name").setDescription("Set the default name for new voice channels")
          .addStringOption((o) => o.setName("name").setDescription("Template, e.g. {user.display_name}'s channel").setRequired(true).setMaxLength(100)))
      .addSubcommand((s) =>
        s.setName("region").setDescription("Set the default region for new voice channels")
          .addStringOption((o) => o.setName("region").setDescription("Voice region").setRequired(true)
            .addChoices(...logic.REGIONS.map((r) => ({ name: r, value: r })))))
      .addSubcommand((s) => kbpsOption(s.setName("bitrate").setDescription("Set the default bitrate for new voice channels")))
      .addSubcommand((s) => settingOption("Post the panel in each new channel")(s.setName("interface").setDescription("Post an interface panel in new channels")))
  )
  .addSubcommandGroup((g) =>
    g.setName("category").setDescription("Categories for VoiceMaster channels")
      .addSubcommand((s) => categoryOption(s.setName("public").setDescription("Set the public category for VoiceMaster channels")))
      .addSubcommand((s) => categoryOption(s.setName("private").setDescription("Set the private category for VoiceMaster channels")))
  );

sub(data, "setup", "Create the VoiceMaster category and channels");
sub(data, "sendinterface", "Resend the VoiceMaster interface panel");
sub(data, "reset", "Delete the VoiceMaster channels and configuration");
sub(data, "clear", "Reset a VoiceMaster setting to its default", (s) =>
  s.addStringOption((o) => o.setName("setting").setDescription("Setting to reset").setRequired(true)
    .addChoices(...Object.keys(logic.CLEAR_SETTINGS).map((k) => ({ name: k, value: k })))));
sub(data, "lock", "Lock your voice channel");
sub(data, "unlock", "Unlock your voice channel");
sub(data, "ghost", "Hide your voice channel from everyone else");
sub(data, "unghost", "Reveal your hidden voice channel");
sub(data, "name", "Rename your voice channel", (s) =>
  s.addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true).setMaxLength(100)));
sub(data, "status", "Set the status shown on your voice channel", (s) =>
  s.addStringOption((o) => o.setName("status").setDescription("Status text (\"clear\" removes it)").setRequired(true).setMaxLength(500)));
sub(data, "limit", "Set the member limit for your voice channel", (s) =>
  s.addIntegerOption((o) => o.setName("limit").setDescription("0 = unlimited").setRequired(true).setMinValue(0).setMaxValue(99)));
sub(data, "bitrate", "Change your voice channel's bitrate", kbpsOption);
sub(data, "music", "Mute everyone but yourself in your channel", settingOption("On or off"));
sub(data, "role", "Give a role to everyone who joins your channel", roleOption("Role to give (same role again turns it off)"));
sub(data, "permit", "Permit a member or role to join your channel", (s) =>
  s.addMentionableOption((o) => o.setName("target").setDescription("Member or role").setRequired(true)));
sub(data, "reject", "Reject a member or role from joining your channel", (s) =>
  s.addMentionableOption((o) => o.setName("target").setDescription("Member or role").setRequired(true)));
sub(data, "claim", "Claim an inactive voice channel");
sub(data, "transfer", "Transfer ownership of your channel to another member", (s) =>
  s.addUserOption((o) => o.setName("member").setDescription("New owner (must be in your channel)").setRequired(true)));
sub(data, "config", "View and edit this server's VoiceMaster settings");
sub(data, "info", "View your voice channel's settings");

// ---------------------------------------------------------------- server settings

const requireSetup = (guildId) =>
  ensure(store.getConfig(guildId), "VoiceMaster isn't set up here yet. Run `/voicemaster setup` first.");

const setter = (column, read, describe) => async (interaction, ctx) => {
  const value = read(interaction, ctx);
  store.setConfig(ctx.guild.id, { [column]: value });
  return ctx.success(describe(value, interaction));
};

async function setup(interaction, ctx) {
  const guild = ctx.guild;
  const existing = store.getConfig(guild.id);
  if (existing?.hub_channel_id && guild.channels.cache.has(existing.hub_channel_id))
    throw new UserError(`VoiceMaster is already set up (<#${existing.hub_channel_id}>). Use \`/voicemaster reset\` first to start over.`);
  guard.assertBotPermissions(guild, [...service.REQUIRED_BOT_PERMS, P.SendMessages, P.EmbedLinks]);

  const me = guild.members.me;
  const reason = `VoiceMaster setup by ${ctx.user.tag}`;
  const categoryChannel = await guild.channels.create({ name: "VoiceMaster", type: ChannelType.GuildCategory, reason });
  const hub = await guild.channels.create({ name: "➕ Join to Create", type: ChannelType.GuildVoice, parent: categoryChannel.id, reason });
  const iface = await guild.channels.create({
    name: "interface",
    type: ChannelType.GuildText,
    parent: categoryChannel.id,
    reason,
    permissionOverwrites: [
      { id: guild.id, deny: [P.SendMessages] },
      { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
    ],
  });

  store.setConfig(guild.id, {
    hub_channel_id: hub.id,
    interface_channel_id: iface.id,
    created_category_id: categoryChannel.id,
    // Keep a public category chosen earlier; otherwise use the new one.
    public_category_id: service.category(guild, existing?.public_category_id)?.id ?? categoryChannel.id,
  });
  await ui.safeSend(iface, service.buildPanel(ctx.client, guild));
  return ctx.success(`VoiceMaster is ready. Join ${hub} to create a channel; the panel is in ${iface}.`);
}

async function sendInterface(interaction, ctx) {
  requireSetup(ctx.guild.id);
  const cfg = store.getConfig(ctx.guild.id);
  let target = cfg.interface_channel_id && ctx.guild.channels.cache.get(cfg.interface_channel_id);
  if (!target) {
    // No interface channel any more: use this one and remember it.
    ensure(ctx.channel?.isTextBased() && !ctx.channel.isThread(), "Run this in a text channel.");
    target = ctx.channel;
    store.setConfig(ctx.guild.id, { interface_channel_id: target.id });
  }
  guard.assertBotPermissions(target, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
  await target.send(service.buildPanel(ctx.client, ctx.guild));
  return ctx.success(`Sent the interface panel to ${target}.`);
}

async function reset(interaction, ctx) {
  const guild = ctx.guild;
  const cfg = requireSetup(guild.id);
  const temp = store.listChannels(guild.id);
  const ok = await ui.confirm(
    interaction,
    `Delete the VoiceMaster hub, interface channel${cfg.created_category_id ? ", its category" : ""} and **${temp.length}** temporary voice channel${temp.length === 1 ? "" : "s"}, and erase every VoiceMaster setting?`
  );
  if (!ok) return undefined;

  const removed = new Set();
  const del = async (id) => {
    const channel = id && guild.channels.cache.get(id);
    if (!channel) return;
    removed.add(id);
    await channel.delete(`VoiceMaster reset by ${ctx.user.tag}`).catch((err) => {
      if (err.code !== 10003) throw err;
    });
  };

  for (const row of temp) {
    removed.add(row.channel_id);
    await service.deleteTempChannel(guild, row.channel_id, `VoiceMaster reset by ${ctx.user.tag}`);
  }
  // Take the join role back from anyone still in the hub.
  const hub = guild.channels.cache.get(cfg.hub_channel_id);
  if (cfg.join_role_id) for (const m of service.humans(hub)) await service.removeRole(m, cfg.join_role_id, "VoiceMaster reset");
  await del(cfg.hub_channel_id);
  await del(cfg.interface_channel_id);
  // Only delete the category setup made, and only if nothing else lives in it.
  const made = service.category(guild, cfg.created_category_id);
  if (made && !made.children.cache.some((c) => !removed.has(c.id))) await del(made.id);

  store.removeGuildChannels(guild.id);
  store.deleteConfig(guild.id);
  return ctx.success("VoiceMaster has been reset.");
}

function clear(interaction, ctx) {
  requireSetup(ctx.guild.id);
  const setting = interaction.options.getString("setting", true);
  const fields = logic.CLEAR_SETTINGS[setting];
  ensure(fields, "Unknown setting.");
  store.setConfig(ctx.guild.id, fields);
  return ctx.success(`Reset **${setting.replace("_", " ")}** to its default.`);
}

function configView(interaction, ctx) {
  const cfg = store.getConfig(ctx.guild.id);
  if (!cfg) return ctx.info("VoiceMaster isn't set up. Run `/voicemaster setup`.", "VoiceMaster");
  const ch = (id) => (id ? `<#${id}>` : "Not set");
  const role = (id, fallback = "Not set") => (id ? `<@&${id}>` : fallback);
  const embed = embeds
    .info(ctx.client, `**${store.listChannels(ctx.guild.id).length}** temporary channel(s) open. Change settings with \`/voicemaster default …\`, \`category …\`, \`join role\` and \`clear\`.`, "VoiceMaster settings")
    .addFields(
      { name: "Join to Create", value: ch(cfg.hub_channel_id), inline: true },
      { name: "Interface", value: ch(cfg.interface_channel_id), inline: true },
      { name: "Public category", value: ch(cfg.public_category_id), inline: true },
      { name: "Private category", value: ch(cfg.private_category_id), inline: true },
      { name: "Default name", value: `\`${cfg.default_name ?? logic.DEFAULT_NAME}\``, inline: true },
      { name: "Default region", value: cfg.default_region ?? "Automatic", inline: true },
      { name: "Default bitrate", value: cfg.default_bitrate ? `${cfg.default_bitrate} kbps` : "Discord default (64 kbps)", inline: true },
      { name: "Panel in new channels", value: logic.yesNo(cfg.default_interface), inline: true },
      { name: "Join role", value: role(cfg.join_role_id), inline: true },
      { name: "Default role", value: role(cfg.default_role_id, "@everyone"), inline: true }
    );
  return ctx.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------- handlers

const own = (fn) => ({ defer: "ephemeral", run: async (interaction, ctx) => ctx.success(await fn(interaction, ctx)) });

module.exports = defineCommand({
  data,
  module: "voicemaster",
  handlers: {
    "join role": {
      gate: "Manage Guild & Roles",
      run: (interaction, ctx) => {
        const r = interaction.options.getRole("role", true);
        guard.assertManageableRole(ctx.member, r);
        store.setConfig(ctx.guild.id, { join_role_id: r.id });
        return ctx.success(`Members in a VoiceMaster channel now get ${r}.`);
      },
    },
    // Not assigned to anyone (only used in channel overwrites), so @everyone is allowed.
    "default role": {
      gate: "Manage Guild & Roles",
      run: setter("default_role_id", (i) => i.options.getRole("role", true).id, (id) => `Lock, ghost and music mode now change <@&${id}>'s permissions.`),
    },
    "default name": {
      gate: "Manage Guild",
      run: (interaction, ctx) => {
        const template = interaction.options.getString("name", true).trim();
        ensure(template, "The name can't be empty.");
        store.setConfig(ctx.guild.id, { default_name: template });
        return ctx.success(`New channels will be named like **${logic.renderName(template, ctx.member)}**.`);
      },
    },
    "default region": {
      gate: "Manage Guild",
      run: setter(
        "default_region",
        (i) => (i.options.getString("region", true) === "auto" ? null : i.options.getString("region", true)),
        (region) => `New channels will use the **${region ?? "automatic"}** region.`
      ),
    },
    "default bitrate": {
      gate: "Manage Guild",
      run: (interaction, ctx) => {
        const kbps = interaction.options.getInteger("kbps", true);
        const max = Math.floor(ctx.guild.maximumBitrate / 1000);
        ensure(kbps <= max, `This server's maximum bitrate is **${max} kbps** (boosting raises it).`);
        store.setConfig(ctx.guild.id, { default_bitrate: kbps });
        return ctx.success(`New channels will use **${kbps} kbps**.`);
      },
    },
    "default interface": {
      gate: "Manage Guild",
      run: setter("default_interface", (i) => (i.options.getBoolean("setting", true) ? 1 : 0), (on) =>
        on ? "New channels will get the interface panel in their chat." : "New channels won't get an interface panel."),
    },
    "category public": {
      gate: "Manage Guild",
      run: setter("public_category_id", (i) => i.options.getChannel("category", true).id, (id) => `New channels will be created in <#${id}>.`),
    },
    "category private": {
      gate: "Manage Guild",
      run: setter("private_category_id", (i) => i.options.getChannel("category", true).id, (id) => `Hidden channels will move to <#${id}>.`),
    },
    setup: { gate: "Manage Guild", run: setup },
    sendinterface: { gate: "Manage Guild", run: sendInterface },
    reset: { gate: "Manage Guild", run: reset },
    // The package table has no gate, but every setting is server-level.
    clear: { gate: "Manage Guild", run: clear },
    config: { run: configView },

    lock: own((i, ctx) => service.lock(ctx.member)),
    unlock: own((i, ctx) => service.unlock(ctx.member)),
    ghost: { gate: "Tier 2 Only", ...own((i, ctx) => service.ghost(ctx.member)) },
    unghost: { gate: "Tier 2 Only", ...own((i, ctx) => service.unghost(ctx.member)) },
    name: own((i, ctx) => service.rename(ctx.member, i.options.getString("name", true))),
    status: own((i, ctx) => service.setStatus(ctx.member, i.options.getString("status", true))),
    limit: own((i, ctx) => service.setLimit(ctx.member, i.options.getInteger("limit", true))),
    bitrate: own((i, ctx) => service.setBitrate(ctx.member, i.options.getInteger("kbps", true))),
    music: own((i, ctx) => service.setMusic(ctx.member, i.options.getBoolean("setting", true))),
    role: { gate: "Manage Roles", ...own((i, ctx) => service.setRole(ctx.member, i.options.getRole("role", true))) },
    permit: own((i, ctx) => service.permit(ctx.member, i.options.getMentionable("target", true))),
    reject: own((i, ctx) => service.reject(ctx.member, i.options.getMentionable("target", true))),
    claim: own((i, ctx) => service.claim(ctx.member)),
    transfer: own((i, ctx) => service.transfer(ctx.member, i.options.getMember("member"))),
    info: { defer: "ephemeral", run: (i, ctx) => ctx.reply({ embeds: [service.infoEmbed(ctx.member)] }) },
  },
});
