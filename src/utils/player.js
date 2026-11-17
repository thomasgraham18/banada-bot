/**
 * The "now playing" player panel.
 *
 * One message per guild, built with Discord's Components V2 (a single
 * container holding the song, progress bar, status, up-next list and the
 * control buttons). The panel is edited in place instead of posting a new
 * message for every song or button press:
 *
 *   show()    - a song started: edit the panel, or re-post it at the bottom
 *               of the channel if other messages have pushed it up
 *   refresh() - something changed (pause, volume, queue...): edit in place
 *   end()     - the queue is gone: show "ended" and remove the buttons
 *
 * Buttons are handled by handleButton(), which is called from
 * events/guild/interactionCreate.js for every custom id starting with "np:".
 * There is no collector, so the buttons never time out.
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  Routes,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} = require("discord.js");
const { RepeatMode, formatDuration } = require("distube");
const icons = require("./icons");

const ID_PREFIX = "np:";
const BAR_LENGTH = 18;
const UP_NEXT_COUNT = 3;
const QUEUE_LIST_COUNT = 15;
const MAX_VOLUME = 200;
const VOLUME_STEP = 10;
// How often the progress bar is redrawn while a song is playing.
const PROGRESS_INTERVAL_MS = 15000;

/** guildId -> { message, timer, song, work } */
const panels = new Map();

// ---------------------------------------------------------------- helpers

const text = (content) => new TextDisplayBuilder().setContent(content);

// Titles go inside [link](url) markdown, so brackets would break the link.
const clean = (value, max = 80) => {
  const name = String(value ?? "Unknown").replace(/[[\]]/g, "");
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
};

const songLink = (song, max) =>
  song.url ? `[${clean(song.name, max)}](${song.url})` : clean(song.name, max);

const accentColour = (client) => {
  const colour = parseInt(client.colour, 16);
  return Number.isNaN(colour) ? 0x580476 : colour;
};

function progressLine(queue, song) {
  if (song.isLive || !song.duration) return "🔴 **LIVE**";

  const ratio = Math.min(1, Math.max(0, queue.currentTime / song.duration));
  const position = Math.min(BAR_LENGTH - 1, Math.floor(ratio * BAR_LENGTH));
  const bar =
    "━".repeat(position) + "●" + "─".repeat(BAR_LENGTH - 1 - position);

  return `\`${formatDuration(queue.currentTime)}\` ${bar} \`${song.formattedDuration}\``;
}

function statusLine(queue) {
  const loop =
    queue.repeatMode === RepeatMode.SONG
      ? "Loop: song"
      : queue.repeatMode === RepeatMode.QUEUE
      ? "Loop: queue"
      : "Loop: off";

  return [
    `Volume ${queue.volume}%`,
    loop,
    `Autoplay: ${queue.autoplay ? "on" : "off"}`,
  ].join("  •  ");
}

// `icon` is a name from utils/icons.js (custom icon, or emoji as fallback).
const button = (id, icon, { active = false, danger = false, disabled = false } = {}) =>
  new ButtonBuilder()
    .setCustomId(ID_PREFIX + id)
    .setEmoji(icons.get(icon))
    .setStyle(
      danger
        ? ButtonStyle.Danger
        : active
        ? ButtonStyle.Success
        : ButtonStyle.Secondary
    )
    .setDisabled(disabled);

// ---------------------------------------------------------------- layouts

/** The full player for a queue that is playing or paused. */
function buildPlayer(client, queue) {
  const song = queue.songs[0];
  const upcoming = queue.songs.slice(1);

  const heading = [
    `-# ${queue.paused ? "⏸  PAUSED" : "▶  NOW PLAYING"}`,
    `### ${songLink(song)}`,
    [song.uploader?.name, song.user ? `Requested by ${song.user}` : null]
      .filter(Boolean)
      .join("  •  ") || "​",
  ].join("\n");

  const container = new ContainerBuilder().setAccentColor(accentColour(client));

  if (song.thumbnail) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(heading))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(song.thumbnail))
    );
  } else {
    container.addTextDisplayComponents(text(heading));
  }

  container.addTextDisplayComponents(
    text(`${progressLine(queue, song)}\n-# ${statusLine(queue)}`)
  );

  container.addSeparatorComponents(new SeparatorBuilder());

  if (upcoming.length > 0) {
    const lines = upcoming
      .slice(0, UP_NEXT_COUNT)
      .map(
        (next, i) =>
          `${i + 1}. ${songLink(next, 60)} \`${next.formattedDuration}\``
      );
    const more = upcoming.length - UP_NEXT_COUNT;
    if (more > 0) lines.push(`-# …and ${more} more  •  ${queue.formattedDuration} total`);

    container.addTextDisplayComponents(text(`**Up next**\n${lines.join("\n")}`));
  } else {
    container.addTextDisplayComponents(
      text(
        queue.autoplay
          ? "-# Nothing queued. Autoplay will pick the next song."
          : "-# Nothing queued. Add more with /play."
      )
    );
  }

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      button("previous", "previous", { disabled: queue.previousSongs.length === 0 }),
      button("toggle", queue.paused ? "play" : "pause", { active: queue.paused }),
      button("skip", "skip"),
      button("stop", "stop", { danger: true }),
      button("queue", "queue")
    ),
    new ActionRowBuilder().addComponents(
      button("shuffle", "shuffle", { disabled: upcoming.length < 2 }),
      button("loop", queue.repeatMode === RepeatMode.SONG ? "loop_one" : "loop", {
        active: queue.repeatMode !== RepeatMode.DISABLED,
      }),
      button("autoplay", "autoplay", { active: queue.autoplay }),
      button("voldown", "vol_down", { disabled: queue.volume <= 0 }),
      button("volup", "vol_up", { disabled: queue.volume >= MAX_VOLUME })
    )
  );

  return { components: [container], allowedMentions: { parse: [] } };
}

/** What the panel turns into when playback is over. No buttons. */
function buildEnded(client, song) {
  const container = new ContainerBuilder()
    .setAccentColor(accentColour(client))
    .addTextDisplayComponents(
      text(
        [
          "-# ⏹  PLAYBACK ENDED",
          song ? `Last played: ${songLink(song)}` : null,
          "-# Use /play to start again.",
        ]
          .filter(Boolean)
          .join("\n")
      )
    );

  return { components: [container], allowedMentions: { parse: [] } };
}

/** The queue list shown (only to the person who asked) by the queue button. */
function buildQueueList(client, queue) {
  const [current, ...upcoming] = queue.songs;

  const lines = upcoming
    .slice(0, QUEUE_LIST_COUNT)
    .map(
      (song, i) =>
        `${i + 1}. ${songLink(song, 60)} \`${song.formattedDuration}\``
    );
  const more = upcoming.length - QUEUE_LIST_COUNT;
  if (more > 0) lines.push(`-# …and ${more} more. Use /queue to page through them.`);

  const container = new ContainerBuilder()
    .setAccentColor(accentColour(client))
    .addTextDisplayComponents(
      text(
        `**Now playing**\n${songLink(current)} \`${current.formattedDuration}\``
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      text(
        lines.length
          ? `**Up next**\n${lines.join("\n")}`
          : "-# Nothing else is queued."
      ),
      text(
        `-# ${queue.songs.length} song${
          queue.songs.length === 1 ? "" : "s"
        }  •  ${queue.formattedDuration} total`
      )
    );

  return { components: [container], allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------- state

/**
 * Runs panel updates for a guild one after another, so two events arriving
 * together (e.g. playSong + a button press) cannot post two panels.
 */
function serial(guildId, task) {
  const state = panels.get(guildId) ?? {};
  panels.set(guildId, state);
  state.work = (state.work ?? Promise.resolve())
    .then(task)
    .catch((err) => console.error("[player] panel update failed:", err));
  return state.work;
}

function stopTimer(state) {
  clearInterval(state?.timer);
  if (state) state.timer = null;
}

function startTimer(client, guildId) {
  const state = panels.get(guildId);
  if (!state || state.timer) return;

  state.timer = setInterval(() => {
    const queue = client.distube.getQueue(guildId);
    // A paused song's progress bar does not move, so skip the edit.
    if (queue && !queue.paused) refresh(client, guildId);
  }, PROGRESS_INTERVAL_MS);
  state.timer.unref?.();
}

/**
 * Shows the song in the voice channel's status line ("🎶 Song name" under the
 * channel name). Needs the Set Voice Channel Status permission; without it
 * this quietly does nothing.
 */
function setVoiceStatus(client, channelId, status) {
  if (!channelId) return;
  client.rest
    .put(Routes.channelVoiceStatus(channelId), { body: { status } })
    .catch(() => {});
}

// ---------------------------------------------------------------- public API

/**
 * A song started. Edits the existing panel when it is still the newest
 * message in the channel, otherwise posts a fresh one at the bottom and
 * removes the old one.
 * @param {BotClient} client
 * @param {Queue} queue
 * @param {{ forceNew?: boolean }} [options] forceNew re-posts even if the panel is already last
 */
function show(client, queue, { forceNew = false } = {}) {
  const channel = queue.textChannel;
  if (!channel) return Promise.resolve();

  return serial(queue.id, async () => {
    const state = panels.get(queue.id);
    const payload = buildPlayer(client, queue);
    const old = state.message;
    state.song = queue.songs[0];

    const canEdit =
      old &&
      !forceNew &&
      old.channelId === channel.id &&
      channel.lastMessageId === old.id;

    if (canEdit) {
      try {
        await old.edit(payload);
      } catch {
        state.message = null; // deleted by someone: fall through and re-post
      }
    }

    if (!canEdit || !state.message) {
      state.message = await channel.send({
        ...payload,
        flags: MessageFlags.IsComponentsV2,
      });
      if (old) old.delete().catch(() => {});
    }

    setVoiceStatus(
      client,
      queue.voiceChannel?.id,
      `🎶 ${clean(state.song.name, 100)}`
    );
    startTimer(client, queue.id);
  });
}

/**
 * Redraws the panel in place. Safe to call at any time; does nothing when
 * the guild has no panel or no queue.
 */
function refresh(client, guildId) {
  const state = panels.get(guildId);
  if (!state?.message) return Promise.resolve();

  return serial(guildId, async () => {
    const queue = client.distube.getQueue(guildId);
    if (!queue || !state.message || queue.songs.length === 0) return;

    state.song = queue.songs[0];
    try {
      await state.message.edit(buildPlayer(client, queue));
    } catch (err) {
      // 10008 = Unknown Message: the panel was deleted. It comes back with
      // the next song (or /nowplaying).
      if (err?.code === 10008) state.message = null;
      else throw err;
    }
  });
}

/** The queue was deleted (finished, stopped or disconnected). */
function end(client, queue) {
  const state = panels.get(queue.id);
  if (!state) return Promise.resolve();

  stopTimer(state);
  setVoiceStatus(client, queue.voiceChannel?.id, "");

  return serial(queue.id, async () => {
    const { message, song } = state;
    panels.delete(queue.id);
    if (message) await message.edit(buildEnded(client, song)).catch(() => {});
  });
}

/**
 * Handles a click on one of the panel buttons.
 * @param {BotClient} client
 * @param {import("discord.js").ButtonInteraction} interaction
 */
async function handleButton(client, interaction) {
  const action = interaction.customId.slice(ID_PREFIX.length);
  const whisper = (content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

  const queue = client.distube.getQueue(interaction.guildId);
  if (!queue) {
    // A panel left over from before a restart: retire it.
    return interaction
      .update(buildEnded(client))
      .catch(() => whisper("Nothing is playing right now."));
  }

  // Looking at the queue is allowed for everyone.
  if (action === "queue") {
    return interaction.reply({
      ...buildQueueList(client, queue),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  const botChannelId = interaction.guild.members.me?.voice.channelId;
  if (!botChannelId || interaction.member.voice.channelId !== botChannelId)
    return whisper("Join my voice channel to use the player controls.");

  // Acknowledge first: skipping or stopping can take longer than 3 seconds.
  await interaction.deferUpdate();

  try {
    switch (action) {
      case "toggle":
        if (queue.paused) await queue.resume();
        else await queue.pause();
        break;

      case "previous":
        if (queue.previousSongs.length > 0) await queue.previous();
        break;

      case "skip":
        // Skipping the last song (with autoplay off) ends playback.
        if (queue.songs.length > 1 || queue.autoplay) await queue.skip();
        else await stop(client, queue);
        break;

      case "stop":
        await stop(client, queue);
        break;

      case "shuffle":
        await queue.shuffle();
        break;

      case "loop":
        // off -> song -> queue -> off
        queue.setRepeatMode((queue.repeatMode + 1) % 3);
        break;

      case "autoplay":
        queue.toggleAutoplay();
        break;

      case "voldown":
        queue.setVolume(Math.max(0, queue.volume - VOLUME_STEP));
        break;

      case "volup":
        queue.setVolume(Math.min(MAX_VOLUME, queue.volume + VOLUME_STEP));
        break;

      default:
        return;
    }
  } catch (err) {
    console.error(`[player] button "${action}" failed:`, err);
    await interaction
      .followUp({
        content: `That didn't work: ${String(err?.message ?? err).slice(0, 300)}`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }

  // skip / previous / stop redraw through the playSong and deleteQueue events;
  // this covers everything else and is harmless for those three.
  await refresh(client, interaction.guildId);
}

/** Stops playback and applies the LEAVE_STOP setting. */
async function stop(client, queue) {
  const guild = queue.voiceChannel?.guild;
  await queue.stop();
  if (client.leaveOnStop && guild) client.distube.voices.leave(guild);
}

const isPlayerButton = (interaction) =>
  interaction.isButton() && interaction.customId.startsWith(ID_PREFIX);

module.exports = {
  show,
  refresh,
  end,
  stop,
  handleButton,
  isPlayerButton,
  // Exported for scripts/check.js
  buildPlayer,
  buildEnded,
  buildQueueList,
};
