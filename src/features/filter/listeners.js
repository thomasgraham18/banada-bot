/**
 * Filter listeners. All registered with module "filter" / event "filter", so
 * /ignore and /access module|event filter are honoured before they run.
 */
const { listeners } = require("../../core");
const service = require("./service");

module.exports = function registerListeners() {
  const scope = { module: "filter", event: "filter" };

  // Runs before every other message listener (priority), and marks filtered
  // messages consumed so autoresponders, XP, stickies... ignore them.
  listeners.on("messageCreate", { name: "filter:message", priority: 10, ...scope }, async (client, message) => {
    if (await service.checkMessage(message)) listeners.consume(message);
  });

  // Edits: re-check the text-based filters when the content actually changed.
  listeners.on("messageUpdate", { name: "filter:edit", ...scope }, async (client, oldMessage, newMessage) => {
    if (!newMessage.inGuild?.() || newMessage.author?.bot) return;
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return; // embed unfurl etc.
    if (newMessage.partial) newMessage = await newMessage.fetch().catch(() => null);
    if (newMessage) await service.checkMessage(newMessage, { edited: true });
  });

  // Names filter: on join and whenever the display name changes.
  listeners.on("guildMemberAdd", { name: "filter:names-join", ...scope }, async (client, member) => {
    await service.enforceName(member);
  });
  listeners.on("guildMemberUpdate", { name: "filter:names-update", ...scope }, async (client, oldMember, newMember) => {
    if (!oldMember.partial && oldMember.displayName === newMember.displayName) return;
    await service.enforceName(newMember);
  });
};
