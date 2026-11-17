/**
 * /giveaways: start, end, cancel, reroll, list, and 15 `edit` subcommands.
 *
 * Giveaways are referred to by message ID or link (autocomplete fills it in).
 * Every edit re-renders the giveaway message; `edit duration` moves the
 * scheduled end job. Edits only apply to giveaways that are still running.
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits: P } = require("discord.js");
const { defineCommand, parse, guard, ui, UserError } = require("../../../core");
const store = require("../db");
const logic = require("../logic");
const service = require("../service");

// ---------------------------------------------------------------- builders

const giveawayOption = (o) =>
  o.setName("giveaway").setDescription("The giveaway (message link or ID)").setRequired(true).setAutocomplete(true);
const winnersOption = (o, name, required) =>
  o.setName(name).setDescription("Number of winners (1-50)").setMinValue(1).setMaxValue(logic.MAX_WINNERS).setRequired(required);
const daysOption = (o, description) =>
  o.setName("days").setDescription(description).setMinValue(0).setMaxValue(3650).setRequired(true);
const levelOption = (o, description) =>
  o.setName("level").setDescription(description).setMinValue(0).setMaxValue(1000).setRequired(true);

const data = new SlashCommandBuilder()
  .setName("giveaways")
  .setDescription("Run giveaways")
  .addSubcommandGroup((g) =>
    g.setName("edit").setDescription("Change a running giveaway")
      .addSubcommand((s) => s.setName("description").setDescription("Change description for a giveaway")
        .addStringOption(giveawayOption)
        .addStringOption((o) => o.setName("text").setDescription("New description (\"none\" to clear)").setMaxLength(2000).setRequired(true)))
      .addSubcommand((s) => s.setName("prize").setDescription("Change prize for a giveaway")
        .addStringOption(giveawayOption)
        .addStringOption((o) => o.setName("prize").setDescription("New prize").setMaxLength(256).setRequired(true)))
      .addSubcommand((s) => s.setName("color").setDescription("Change color for a giveaway")
        .addStringOption(giveawayOption)
        .addStringOption((o) => o.setName("color").setDescription("Hex like #ff8800, or a name like red").setRequired(true)))
      .addSubcommand((s) => s.setName("image").setDescription("Change image for a giveaway")
        .addStringOption(giveawayOption)
        .addAttachmentOption((o) => o.setName("attachment").setDescription("Image file (leave both empty to remove)"))
        .addStringOption((o) => o.setName("url").setDescription("Image URL (leave both empty to remove)")))
      .addSubcommand((s) => s.setName("thumbnail").setDescription("Change thumbnail for a giveaway")
        .addStringOption(giveawayOption)
        .addAttachmentOption((o) => o.setName("attachment").setDescription("Image file (leave both empty to remove)"))
        .addStringOption((o) => o.setName("url").setDescription("Image URL (leave both empty to remove)")))
      .addSubcommand((s) => s.setName("winners").setDescription("Change the amount of winners for a giveaway")
        .addStringOption(giveawayOption)
        .addIntegerOption((o) => winnersOption(o, "count", true)))
      .addSubcommand((s) => s.setName("hidewinners").setDescription("Hide the winners of a giveaway")
        .addStringOption(giveawayOption)
        .addBooleanOption((o) => o.setName("hide").setDescription("Hide winners (default: true)")))
      .addSubcommand((s) => s.setName("minlevel").setDescription("Set the minimum level requirement for giveaway entry")
        .addStringOption(giveawayOption)
        .addIntegerOption((o) => levelOption(o, "Minimum level (0 removes the requirement)")))
      .addSubcommand((s) => s.setName("maxlevel").setDescription("Set the maximum level requirement for giveaway entry")
        .addStringOption(giveawayOption)
        .addIntegerOption((o) => levelOption(o, "Maximum level (0 removes the requirement)")))
      .addSubcommand((s) => s.setName("age").setDescription("Set minimum account age for new entries")
        .addStringOption(giveawayOption)
        .addIntegerOption((o) => daysOption(o, "Minimum account age in days (0 removes it)")))
      .addSubcommand((s) => s.setName("stay").setDescription("Set minimum server stay for new entries")
        .addStringOption(giveawayOption)
        .addIntegerOption((o) => daysOption(o, "Minimum days in the server (0 removes it)")))
      .addSubcommand((s) => {
        s.setName("host").setDescription("Set new hosts for a giveaway").addStringOption(giveawayOption);
        for (let i = 1; i <= 5; i++) s.addUserOption((o) => o.setName(`user${i}`).setDescription(`Host ${i}`).setRequired(i === 1));
        return s;
      })
      .addSubcommand((s) => {
        s.setName("requiredroles").setDescription("Set required roles for giveaway entry").addStringOption(giveawayOption);
        for (let i = 1; i <= 5; i++) s.addRoleOption((o) => o.setName(`role${i}`).setDescription(`Required role ${i} (none = remove all)`));
        return s;
      })
      .addSubcommand((s) => s.setName("roles").setDescription("Award winners specific roles for a giveaway")
        .addStringOption(giveawayOption)
        .addRoleOption((o) => o.setName("role1").setDescription("Role for winners (none = remove all)"))
        .addRoleOption((o) => o.setName("role2").setDescription("Second role for winners")))
      .addSubcommand((s) => s.setName("duration").setDescription("Change the end date for a giveaway")
        .addStringOption(giveawayOption)
        .addStringOption((o) => o.setName("date").setDescription("New end: a duration from now (2d) or a date (2026-12-25 18:00)").setRequired(true)))
  )
  .addSubcommand((s) => s.setName("start").setDescription("Start a giveaway with your provided duration, winners and prize description")
    .addStringOption((o) => o.setName("duration").setDescription("How long it runs, e.g. 1h, 2d, 1w").setRequired(true))
    .addStringOption((o) => o.setName("prize").setDescription("What's being given away").setMaxLength(256).setRequired(true))
    .addIntegerOption((o) => winnersOption(o, "winners", false))
    .addChannelOption((o) => o.setName("channel").setDescription("Where to post it (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) => s.setName("end").setDescription("End an active giveaway early").addStringOption(giveawayOption))
  .addSubcommand((s) => s.setName("cancel").setDescription("Delete a giveaway without picking any winners").addStringOption(giveawayOption))
  .addSubcommand((s) => s.setName("reroll").setDescription("Reroll a winner for the specified giveaway")
    .addStringOption((o) => o.setName("giveaway").setDescription("Ended giveaway (default: the latest in this channel)").setAutocomplete(true))
    .addIntegerOption((o) => winnersOption(o, "winners", false)))
  .addSubcommand((s) => s.setName("list").setDescription("List every giveaway in the server"));

// ---------------------------------------------------------------- helpers

/** The giveaway named by the `giveaway` option, which must still be running. */
function activeGiveaway(ctx) {
  const gw = service.resolve(ctx.guild.id, ctx.options.getString("giveaway", true));
  if (gw.ended) throw new UserError("That giveaway has already ended.");
  return gw;
}

/** Saves one column, re-renders the message and confirms. */
async function saveAndRefresh(ctx, gw, changes, text, files) {
  for (const [column, value] of Object.entries(changes)) store.update(gw.id, column, value);
  const updated = store.get(gw.id);
  const found = await service.refreshMessage(ctx.client, updated, files);
  return ctx.success(`${text}${found ? "" : "\n-# The giveaway message is gone, so only the record was updated."} ([giveaway](${service.jumpLink(updated)}))`);
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Shared by edit image / edit thumbnail. An attachment is re-uploaded onto the
 * giveaway message and referenced as attachment://gw-<kind>.<ext>, because the
 * URL of a slash-command attachment expires after a while.
 */
function imageHandler(column) {
  return async (interaction, ctx) => {
    const gw = activeGiveaway(ctx);
    const attachment = ctx.options.getAttachment("attachment");
    const url = ctx.options.getString("url")?.trim();
    if (attachment && url) throw new UserError("Give an attachment **or** a URL, not both.");
    const old = gw[column];
    const drop = old?.startsWith("attachment://") ? [old.slice("attachment://".length)] : [];

    if (attachment) {
      if (!attachment.contentType?.startsWith("image/")) throw new UserError("That attachment isn't an image.");
      if (attachment.size > MAX_IMAGE_BYTES) throw new UserError("That image is too large (max 8 MB).");
      const ext = (attachment.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
      const name = `gw-${column}.${ext}`;
      return saveAndRefresh(ctx, gw, { [column]: `attachment://${name}` }, `Updated the ${column}.`, { add: [{ url: attachment.url, name }], drop });
    }
    if (url) {
      if (!logic.isUrl(url)) throw new UserError("That isn't a valid http(s) URL.");
      return saveAndRefresh(ctx, gw, { [column]: url }, `Updated the ${column}.`, { drop });
    }
    return saveAndRefresh(ctx, gw, { [column]: null }, `Removed the ${column}.`, { drop });
  };
}

/** edit minlevel / maxlevel. */
function levelHandler(column) {
  return async (interaction, ctx) => {
    const gw = activeGiveaway(ctx);
    const level = ctx.options.getInteger("level", true);
    if (level && !service.levelsApi())
      throw new UserError("Level requirements need the levels system, which isn't installed on this bot.");
    const min = column === "min_level" ? level : gw.min_level;
    const max = column === "max_level" ? level : gw.max_level;
    if (min && max && min > max) throw new UserError(`The minimum level (${min}) can't be above the maximum level (${max}).`);
    const label = column === "min_level" ? "Minimum" : "Maximum";
    return saveAndRefresh(ctx, gw, { [column]: level }, level ? `${label} level set to **${level}**.` : `Removed the ${label.toLowerCase()} level requirement.`);
  };
}

/** edit age / stay. */
function daysHandler(column, what) {
  return async (interaction, ctx) => {
    const gw = activeGiveaway(ctx);
    const days = ctx.options.getInteger("days", true);
    return saveAndRefresh(ctx, gw, { [column]: days }, days ? `New entries need ${what} of at least **${days}** day${days === 1 ? "" : "s"}.` : `Removed the ${what} requirement.`);
  };
}

const describe = (gw) => {
  const when = gw.ended ? `ended ${parse.formatDuration(Date.now() - (gw.ended_at ?? gw.ends_at), 2)} ago` : `ends in ${parse.formatDuration(gw.ends_at - Date.now(), 2)}`;
  return `${gw.prize} — ${when}`;
};

// ---------------------------------------------------------------- handlers

const EDIT = "Manage Channels";

module.exports = defineCommand({
  data,
  module: "giveaways",
  handlers: {
    "edit description": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const text = ctx.options.getString("text", true).trim();
        const clear = ["none", "clear", "remove"].includes(text.toLowerCase());
        return saveAndRefresh(ctx, gw, { description: clear ? null : text }, clear ? "Removed the description." : "Updated the description.");
      },
    },
    "edit prize": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const prize = ctx.options.getString("prize", true).trim();
        if (!prize) throw new UserError("The prize can't be empty.");
        return saveAndRefresh(ctx, gw, { prize }, `Prize changed to **${prize}**.`);
      },
    },
    "edit color": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const color = parse.colour(ctx.options.getString("color", true));
        return saveAndRefresh(ctx, gw, { color }, `Colour set to \`${parse.hex(color)}\`.`);
      },
    },
    "edit image": { gate: "Manage Channels & Manage Guild", defer: "ephemeral", run: imageHandler("image") },
    "edit thumbnail": { gate: EDIT, defer: "ephemeral", run: imageHandler("thumbnail") },
    "edit winners": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const count = ctx.options.getInteger("count", true);
        return saveAndRefresh(ctx, gw, { winners: count }, `This giveaway will now have **${count}** winner${count === 1 ? "" : "s"}.`);
      },
    },
    "edit hidewinners": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const hide = ctx.options.getBoolean("hide") ?? true;
        return saveAndRefresh(ctx, gw, { hide_winners: hide }, hide ? "Winners will be hidden (hosts and winners get a DM)." : "Winners will be announced publicly.");
      },
    },
    "edit minlevel": { gate: EDIT, defer: "ephemeral", run: levelHandler("min_level") },
    "edit maxlevel": { gate: EDIT, defer: "ephemeral", run: levelHandler("max_level") },
    "edit age": { gate: "Manage Channels & Roles", defer: "ephemeral", run: daysHandler("min_age_days", "an account age") },
    "edit stay": { gate: "Manage Channels & Roles", defer: "ephemeral", run: daysHandler("min_stay_days", "a server stay") },
    "edit host": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const users = [1, 2, 3, 4, 5].map((i) => ctx.options.getUser(`user${i}`)).filter(Boolean);
        if (users.some((u) => u.bot)) throw new UserError("Bots can't host giveaways.");
        store.replaceList("hosts", gw.id, users.map((u) => u.id));
        return saveAndRefresh(ctx, gw, {}, `Hosts set to ${[...new Set(users)].join(", ")}.`);
      },
    },
    "edit requiredroles": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const roles = [1, 2, 3, 4, 5].map((i) => ctx.options.getRole(`role${i}`)).filter(Boolean);
        if (roles.some((r) => r.id === ctx.guild.id)) throw new UserError("@everyone can't be a required role.");
        store.replaceList("required", gw.id, roles.map((r) => r.id));
        return saveAndRefresh(ctx, gw, {}, roles.length ? `Entrants now need **all** of: ${roles.join(", ")}.` : "Removed the required roles.");
      },
    },
    "edit roles": {
      gate: "Manage Channels & Roles", defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const roles = ["role1", "role2"].map((n) => ctx.options.getRole(n)).filter(Boolean);
        // The bot will add these to winners on the invoker's behalf: hierarchy check now.
        for (const role of roles) guard.assertManageableRole(ctx.member, ctx.guild.roles.cache.get(role.id) ?? role);
        store.replaceList("award", gw.id, roles.map((r) => r.id));
        return saveAndRefresh(ctx, gw, {}, roles.length ? `Winners will receive ${roles.join(", ")}.` : "Winners won't receive any roles.");
      },
    },
    "edit duration": {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const endsAt = parse.date(ctx.options.getString("date", true)).getTime();
        store.update(gw.id, "ends_at", endsAt);
        const updated = store.get(gw.id);
        service.reschedule(updated);
        await service.refreshMessage(ctx.client, updated);
        return ctx.success(`The giveaway now ends ${parse.timestamp(endsAt, "R")} (${parse.timestamp(endsAt, "f")}).`);
      },
    },

    start: {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const ms = parse.duration(ctx.options.getString("duration", true), { min: 10_000, max: 365 * logic.DAY_MS });
        const prize = ctx.options.getString("prize", true).trim();
        if (!prize) throw new UserError("The prize can't be empty.");
        const winners = ctx.options.getInteger("winners") ?? 1;
        const channel = ctx.options.getChannel("channel") ?? ctx.channel;
        if (!channel?.isTextBased?.() || !channel.guild) throw new UserError("I can't post a giveaway in that channel.");
        guard.assertBotPermissions(channel, [P.ViewChannel, P.SendMessages, P.EmbedLinks]);
        if (channel.id !== ctx.channel?.id && !channel.permissionsFor(ctx.member)?.has(P.SendMessages))
          throw new UserError(`You can't send messages in ${channel}.`);

        const gw = await service.start(ctx.client, { guild: ctx.guild, channel, prize, winners, endsAt: Date.now() + ms, hostId: ctx.user.id });
        return ctx.success(
          `Giveaway for **${prize}** started in ${channel}, ending ${parse.timestamp(gw.ends_at, "R")}. ([giveaway](${service.jumpLink(gw)}))\n` +
          "-# Customise it with `/giveaways edit` (description, image, requirements, award roles…)."
        );
      },
    },

    end: {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = activeGiveaway(ctx);
        const winners = await service.end(ctx.client, gw.id);
        if (!winners) throw new UserError("That giveaway has already ended.");
        return ctx.success(`Ended **${gw.prize}** with ${winners.length ? `${winners.length} winner${winners.length === 1 ? "" : "s"}` : "no valid entrants"}.`);
      },
    },

    cancel: {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const gw = service.resolve(ctx.guild.id, ctx.options.getString("giveaway", true));
        const ok = await ui.confirm(interaction, `Delete the giveaway for **${gw.prize}** (${gw.entry_count} entries)? No winners will be picked and the message will be deleted.`);
        if (!ok) return;
        await service.cancel(ctx.client, gw);
        return ctx.success(`Cancelled the giveaway for **${gw.prize}**.`);
      },
    },

    reroll: {
      gate: EDIT, defer: "ephemeral",
      run: async (interaction, ctx) => {
        const text = ctx.options.getString("giveaway");
        let gw;
        if (text) gw = service.resolve(ctx.guild.id, text);
        else {
          const id = store.latestEndedInChannel(ctx.guild.id, ctx.channel.id);
          if (!id) throw new UserError("No giveaway has ended in this channel. Name one with the `giveaway` option.");
          gw = store.get(id);
        }
        const winners = await service.reroll(ctx.client, gw, ctx.options.getInteger("winners") ?? 1);
        if (!winners.length) throw new UserError("Nobody is left to pick: every eligible entrant has already won.");
        return ctx.success(`Rerolled **${gw.prize}**: ${winners.map((id) => `<@${id}>`).join(", ")}.`);
      },
    },

    list: {
      run: async (interaction, ctx) => {
        const rows = store.listForGuild(ctx.guild.id);
        const lines = rows.map((gw) => {
          const link = `https://discord.com/channels/${gw.guild_id}/${gw.channel_id}/${gw.message_id}`;
          const when = gw.ended ? `ended ${parse.timestamp(gw.ended_at ?? gw.ends_at, "R")}` : `ends ${parse.timestamp(gw.ends_at, "R")}`;
          return `${gw.ended ? "⏹️" : "🎉"} [${gw.prize.slice(0, 80)}](${link}) — ${when} • ${gw.entry_count} entr${gw.entry_count === 1 ? "y" : "ies"} • ${gw.winners} winner${gw.winners === 1 ? "" : "s"}`;
        });
        return ui.paginate(interaction, ui.listPages(ctx.client, "Giveaways", lines, { empty: "There are no giveaways in this server. Start one with `/giveaways start`." }));
      },
    },
  },

  // Every `giveaway` option: running giveaways, except reroll (ended ones).
  autocomplete: (interaction, ctx) => {
    const rows = store.listForGuild(ctx.guild.id, { ended: ctx.path === "reroll" });
    return rows.slice(0, 100).map((gw) => ({ name: describe(gw), value: gw.message_id }));
  },
});
