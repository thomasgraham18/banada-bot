/**
 * WP9 VoiceMaster: join-to-create temporary voice channels.
 *   /voicemaster          commands/voicemaster.js
 *   interface panel       components.js (custom-id prefix "vm")
 *   voice / cleanup       listeners.js
 */
require("./db"); // migrations

module.exports = {
  name: "voicemaster",
  commands: [require("./commands/voicemaster")],
  setup(client) {
    require("./listeners")(client);
    require("./components")(client);
  },
  api: {
    /** The temp channel row for a voice channel id, or null. Lets other packages (e.g. music) ask "is this a VM channel?". */
    getChannel: (guildId, channelId) => require("./db").getChannel(guildId, channelId),
  },
};
