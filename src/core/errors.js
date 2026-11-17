/**
 * UserError = "the user did something we can explain" (bad input, missing
 * permission, nothing to remove...). Throw it anywhere inside a handler and
 * the router replies with an ephemeral error embed showing the message.
 *
 * Any other error is a bug: it is logged with its stack and the user gets a
 * generic message.
 */
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

/** Throws a UserError unless `condition` is truthy. */
function ensure(condition, message) {
  if (!condition) throw new UserError(message);
  return condition;
}

// Discord API error codes worth translating into plain English.
const DISCORD_ERRORS = {
  50001: "I can't see that channel (Missing Access).",
  50013: "I'm missing a Discord permission needed for that.",
  50035: "Discord rejected that input as invalid.",
  10003: "That channel no longer exists.",
  10008: "That message no longer exists.",
  10011: "That role no longer exists.",
  10007: "That member is not in the server.",
  10014: "That emoji no longer exists.",
  30005: "This server has reached its role limit (250).",
  30008: "This server has no emoji slots left.",
  50007: "I can't send messages to that user (DMs closed).",
  50045: "That file is too large.",
  50024: "That action can't be done on this channel type.",
};

/** The user-facing text for any error, or null when it's an unexpected bug. */
function describe(err) {
  if (err instanceof UserError) return err.message;
  if (err?.code && DISCORD_ERRORS[err.code]) return DISCORD_ERRORS[err.code];
  return null;
}

module.exports = { UserError, ensure, describe };
