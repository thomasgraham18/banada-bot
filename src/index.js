const BotClient = require("./bot.js");
const client = new BotClient();

client.connect().catch((error) => {
  console.error("Failed to start the bot:", error);
  process.exit(1);
});

module.exports = client;
