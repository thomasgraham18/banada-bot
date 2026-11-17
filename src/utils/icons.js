/**
 * Icons for the player panel buttons.
 *
 * The PNGs in assets/icons are uploaded once as *application emojis*: custom
 * emojis that belong to the bot itself, so they work in every server without
 * using any server's emoji slots. sync() runs at startup, uploads whatever is
 * missing and remembers the ids.
 *
 * Until sync() has succeeded (or if it fails), get() returns the plain
 * Unicode emoji instead, so the buttons always work.
 *
 * To change an icon: replace its PNG, delete the old emoji under
 * "Emojis" in the Discord Developer Portal, and restart the bot.
 */
const fs = require("fs");
const path = require("path");
const { green, yellow, magenta } = require("chalk");

const ICON_DIR = path.join(__dirname, "..", "assets", "icons");
// Emoji names on Discord: np_play, np_pause, ...
const NAME_PREFIX = "np_";

/** icon name (= file name in assets/icons) -> fallback Unicode emoji */
const FALLBACKS = {
  play: "▶️",
  pause: "⏸️",
  stop: "⏹️",
  skip: "⏭️",
  previous: "⏮️",
  queue: "📋",
  shuffle: "🔀",
  loop: "🔁",
  loop_one: "🔂",
  autoplay: "♾️",
  vol_down: "🔉",
  vol_up: "🔊",
};

/** icon name -> { id, name } of the uploaded application emoji */
const uploaded = new Map();

/**
 * What to pass to ButtonBuilder#setEmoji for an icon.
 * @param {keyof typeof FALLBACKS} name
 * @returns {{ id: string, name: string } | string}
 */
function get(name) {
  return uploaded.get(name) ?? FALLBACKS[name];
}

/**
 * Makes sure every icon exists as an application emoji. Call once after login.
 * Never throws: on failure the Unicode fallbacks stay in use.
 * @param {BotClient} client
 */
async function sync(client) {
  try {
    const existing = await client.application.emojis.fetch();
    let created = 0;

    for (const name of Object.keys(FALLBACKS)) {
      const emojiName = NAME_PREFIX + name;
      let emoji = existing.find((e) => e.name === emojiName);

      if (!emoji) {
        const file = path.join(ICON_DIR, `${name}.png`);
        if (!fs.existsSync(file)) continue;
        emoji = await client.application.emojis.create({
          attachment: file,
          name: emojiName,
        });
        created++;
      }

      uploaded.set(name, { id: emoji.id, name: emoji.name });
    }

    console.log(
      `${green("[SUCCESS]")} Player icons ready (${magenta(
        uploaded.size
      )} application emojis${created ? `, ${created} uploaded just now` : ""}).`
    );
  } catch (err) {
    console.warn(
      yellow("[WARN]"),
      "Could not set up the player icons, using standard emojis instead:",
      err?.message ?? err
    );
  }
}

module.exports = { get, sync, FALLBACKS };
