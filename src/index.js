const BotClient = require("./bot.js");
const client = new BotClient();

client.connect();

module.exports = client;
