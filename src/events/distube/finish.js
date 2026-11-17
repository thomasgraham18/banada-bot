/**
 * Emitted when the queue has no more songs to play. The player panel shows
 * "playback ended" by itself (see deleteQueue.js); this only applies the
 * LEAVE_FINISH setting, because DisTube v5 removed its leaveOnFinish option.
 * @param {BotClient} client
 * @param {Queue} queue
 */
module.exports = async (client, queue) => {
  if (client.leaveOnFinish) queue.voice.leave();
};
