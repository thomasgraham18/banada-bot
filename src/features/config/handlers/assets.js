/**
 * /config set icon|splash|banner   (the server's own images)
 * /config customize namestyle|avatar|banner|bio   (the bot's per-server profile)
 *
 * The bot's global avatar and username are shared by every server, so a
 * server admin must never change them. Discord lets a bot set a per-server
 * nickname, avatar, banner and bio on its own member
 * (PATCH /guilds/{id}/members/@me), which is what these commands use.
 */
const { MessageFlags, PermissionFlagsBits: P } = require("discord.js");
const { guard, UserError, embeds } = require("../../../core");
const { pickImageSource, downloadImage } = require("../lib");
const { askModal } = require("./modal");

// ---------------------------------------------------------------- server images

const ASSETS = {
  icon: { label: "server icon", feature: null, tierText: "", animatedFeature: "ANIMATED_ICON", animatedText: "An animated icon needs boost level 1" },
  splash: { label: "invite splash", feature: "INVITE_SPLASH", tierText: "An invite splash needs boost level 1", animatedFeature: null, animatedText: "The invite splash can't be animated" },
  banner: { label: "server banner", feature: "BANNER", tierText: "A server banner needs boost level 2", animatedFeature: "ANIMATED_BANNER", animatedText: "An animated banner needs boost level 3" },
};

function setAsset(kind) {
  const asset = ASSETS[kind];
  return {
    gate: "Manage Guild",
    async run(interaction, ctx) {
      const guild = ctx.guild;
      guard.assertBotPermissions(guild, [P.ManageGuild]);
      if (asset.feature && !guild.features.includes(asset.feature))
        throw new UserError(`${asset.tierText}. This server is level ${guild.premiumTier}.`);

      const source = pickImageSource(ctx.options.getString("url"), ctx.options.getAttachment("attachment"));
      const { buffer, animated } = await downloadImage(source);
      if (animated && !(asset.animatedFeature && guild.features.includes(asset.animatedFeature)))
        throw new UserError(`${asset.animatedText}. Use a PNG, JPEG or WebP instead.`);

      const reason = `/config set ${kind} by ${ctx.user.tag}`;
      await guild.edit({ [kind]: buffer, reason });
      await ctx.reply({ embeds: [embeds.success(ctx.client, `Updated the ${asset.label}.`).setImage(source.url)] });
    },
  };
}

// ---------------------------------------------------------------- bot persona (per guild)

const PERSONA_NOTE =
  "This only changes how I look **in this server**. My global avatar and username are shared with every server, so they can't be changed here.";

function customizeImage(field) {
  return {
    gate: "Server Owner",
    async run(interaction, ctx) {
      const source = pickImageSource(ctx.options.getString("url"), ctx.options.getAttachment("attachment"), { allowNone: true });
      if (!source) {
        // Neither option: reset to my global image.
        await ctx.guild.members.editMe({ [field]: null, reason: `/config customize ${field} reset by ${ctx.user.tag}` });
        return ctx.success(`Reset my server ${field}; I'm using my global ${field} here again.`);
      }
      const { buffer } = await downloadImage(source);
      try {
        await ctx.guild.members.editMe({ [field]: buffer, reason: `/config customize ${field} by ${ctx.user.tag}` });
      } catch (err) {
        if (err?.code === 50035) throw new UserError(`Discord rejected that ${field}: ${err.message.split("\n").pop()}`);
        throw err;
      }
      await ctx.reply({ embeds: [embeds.success(ctx.client, `Updated my server ${field}.\n${PERSONA_NOTE}`)[field === "avatar" ? "setThumbnail" : "setImage"](source.url)] });
    },
  };
}

const customize = {
  namestyle: {
    gate: "Server Owner",
    defer: false, // opens a modal
    async run(interaction, ctx) {
      const me = ctx.guild.members.me;
      guard.assertBotPermissions(ctx.guild, [P.ChangeNickname]);
      const form = await askModal(interaction, {
        title: "My name in this server",
        fields: [{ id: "nick", label: "Nickname (empty = my username)", value: me?.nickname ?? "", placeholder: ctx.client.user.username, max: 32 }],
      });
      if (!form) return;
      ctx.target = form.submit; // later ctx.reply() goes to the modal submission
      await form.submit.deferReply({ flags: MessageFlags.Ephemeral });
      const nick = form.values.nick || null;
      await ctx.guild.members.editMe({ nick, reason: `/config customize namestyle by ${ctx.user.tag}` });
      await ctx.success(
        `${nick ? `My nickname here is now **${nick}**.` : "Removed my nickname here."}\n` +
          "Discord's display name styles (fonts, effects, colours) can't be set by bots through the API, so only the nickname is customisable.\n" +
          PERSONA_NOTE
      );
    },
  },

  avatar: customizeImage("avatar"),
  banner: customizeImage("banner"),

  bio: {
    gate: "Server Owner",
    async run(interaction, ctx) {
      const text = ctx.options.getString("text")?.trim() || null;
      await ctx.guild.members.editMe({ bio: text, reason: `/config customize bio by ${ctx.user.tag}` });
      await ctx.success(`${text ? "Updated my bio for this server." : "Cleared my server bio (my global bio shows again)."}\n${PERSONA_NOTE}`);
    },
  },
};

module.exports = {
  set: { icon: setAsset("icon"), splash: setAsset("splash"), banner: setAsset("banner") },
  customize,
};
