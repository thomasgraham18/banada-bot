const config = require("../../core/config");

/**
 * Emitted when a new queue is created. Sets the queue defaults
 * (DisTube's own default volume is 50%; ours is set in the web panel) and
 * turns autoplay on when /settings autoplay is enabled for the server.
 * @param {BotClient} client
 * @param {Queue} queue
 */
module.exports = async (client, queue) => {
  queue.volume = client.defaultVolume ?? 100;
  if (config.get(queue.id, config.KEYS.MUSIC_AUTOPLAY, false) && !queue.autoplay)
    queue.toggleAutoplay();
};
