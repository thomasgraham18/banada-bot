# Discord

## Lesson 1: What is a Discord?

Discord is a widely-used app for voice, video, and text chat, with over 250 million monthly active users. It is popular among gamers and provides a great way to stay connected with friends and family while playing games. Discord can be accessed via desktop, mobile, and web browsers.

## Lesson 2: What is a Discord bot?

Discord bots are programs that can talk to people in a Discord group. They can be run on a computer or a remote server, and they use Discord's technology to understand what people are saying and respond to them.

For example, a bot could be programmed to automatically welcome new members to the group, or to respond to certain keywords in messages.

Bots can be made using many different programming languages, but we will be using Javascript with a library called 'discord.js'.

## Lesson 3: Interactions

Interactions are the bread and butter of Discord bots. Interactions refer to any action (request) taken by a user while using a bot. This includes sending a message, clicking a button, using a slash command, and more. By listening for specific interactions, bots can respond to users accordingly. For instance, they can execute a command upon receiving a message, or perform a specific action upon a user clicking a button.

## Lesson 4: Events

Events are notifications that Discord sends when a user performs an action, such as sending a message or joining a server. Bots can listen for these events and take action accordingly. For instance, they can send a welcome message to new users or execute a command when a message is sent. The DisTube module can also take advantage of events.

Today, we will focus on the InteractionCreate event, triggered when a user interacts with a bot. We will also use the addSong and playSong events from DisTube, triggered when a song is added to the queue or played.

## Lesson 5: DisTube

DisTube is a powerful node module for discord.js that is easy to use and offers many features. Unlike other comparable modules, it allows users to search for music, queue music, and perform other functions without having to install multiple modules or a lavalink server or database to store the queue.

Today, we will only use DisTube to play music.

## Slash Commands

Since version 13 of discord.js, slash commands were introduced as a new, user-friendly way to interact with bots. Compared to the old method of using commands, which required users to remember specific commands and how to use them, slash commands allow users to click on a command and fill in the required fields using Discord's UI.

# Setup

## Step 1: Create a Discord Account

### Creating a Discord Account

To create a Discord account, visit the Discord website and click the "Sign Up" button in the top right corner of the screen. Enter your email address and create a password, then provide your date of birth and agree to the Discord Terms of Service to create your account.

### Discord Basics

To proceed with this lesson, create a server for your bot to join by clicking the plus button on the left side of the screen and selecting "Create My Own." Choose the following options for the server:

-   For me and my friends
-   Name: musicBot

You can change the name and icon later.

## Step 2: Create a Discord Application

### Discord Developer Portal

1. Go to https://discord.com/developers/applications and sign in to your Discord account if you haven't already.

2. Once you sign in, you will be directed to the Discord Developer Portal. Click on the "New Application" button at the top right corner of the screen.
   <img src="https://i.imgur.com/DzZIA2V.png">

3. Choose a name for your application and click "Create". We will use "lessonBot" as an example name for this guide.

4. After creating your application, click on the "Bot" tab on the left side of the screen.
   <img src="https://i.imgur.com/buodYkp.png">

5. Click the "Add Bot" button, and confirm the action by clicking "Yes, do it!" on the confirmation screen.
   <img src="https://i.imgur.com/SVF9v9M.png">

6. Once you have added your bot, you will be directed to the Bot page. Click the "Copy" button next to the Token field to copy your bot token to your clipboard. **Save this token for later**.
   <img src="https://i.imgur.com/RgCGXX6.png">

7. Enable these permissions for the bot to work properly.
   <img src="https://i.imgur.com/VuOaOWc.png">

8. Now we need to invite the bot to our server. Go to the "OAuth2" tab on the left side of the screen and click "URL Generator". Enable the "bot" & "application.commands" scope. Copy the generated URL and paste it into your browser. You should be greeted with a screen like this. Select the server you want to add the bot to and click on the authorize button.
   <img src="https://i.imgur.com/YS36VDn.png">

9. Sroll down to your generated URL. Copy the URL and paste it into your browser. You should be greeted with a screen like this. Select the server you want to add the bot to and click on the authorize button.
   <img src="https://i.imgur.com/jr2fhVo.png">

Success! You should see your bot join the server. Now we can start coding.

# Step 3: Lets start coding!

Create a new folder for your project and open it in VS Code.

## Setting up your project

1. Create a new folder for your project and open it in your preferred code editor, such as Visual Studio Code.

2. Open a terminal in your project folder and run the following command to initialize your project with NPM:

```
npm init
```

3. Install the following dependencies for your project by running the following command:

```
npm i discord.js distube @discordjs/opus @discordjs/voice @distube/soundcloud @distube/spotify @distube/yt-dlp libsodium-wrappers dotenv chillout chalk@4.1.2

```

4. Now, lets get this file structure setup!

```
📦lessonBot
 ┣ 📂commands
 ┃ ┣ 📜play.js
 ┃ ┗ 📜skip.js
 ┣ 📂events
 ┃ ┗ 📂distube
 ┃ ┃ ┣ 📜addSong.js
 ┃ ┃ ┗ 📜playSong.js
 ┣ 📂handlers
 ┃ ┣ 📜commands.js
 ┃ ┗ 📜events.js
 ┣ 📜bot.js
 ┣ 📜package-lock.json
 ┗ 📜package.json
```

## Creating your bot file

1. Head over to the bot.js you just created.

2. Import the necessary modules for your bot:

```js
const { Client, Events, GatewayIntentBits, Collection } = require('discord.js');
const { DisTube } = require('distube');
```

These imports are needed for ANY bot to work

-   Client is for the bot itself
-   Events is for the bot events.
-   GatewayIntentBits is for the permissions of the bot
-   Collection is for the commands

3. Initialize your bot's client:

```js
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.MessageContent,
	],
});
```

4. Now we link what we did earlier in the developer portal, to our actual code. Replace 'BOT_TOKEN_HERE' with your bot token we copied earlier.

```js
token = 'BOT_TOKEN_HERE';
```

5. Then, create a DisTube instance and attach it to the client.

```js
client.distube = new DisTube(client, {
	leaveOnEmpty: false,
	emptyCooldown: 60,
	leaveOnFinish: false,
	leaveOnStop: false,
});
```

6. Now, we must create a new collection for our commands.

```js
client.commands = new Collection();
```

7. Next, we load our subfolders/files for our commands and event handlers we will be add in the future.

```js
['commands', 'events'].forEach((x) => require(`./handlers/${x}`)(client));
```

8. And now, we will use the 'ClientReady' event sent from Discord.js to log that the bot is ready.

```js
client.once(Events.ClientReady, (c) => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
});
```

9. Almost there! Lets login our bot.

```js
client.login(token);
```

10. Last but not least! Now we need to handle Interactions!

```js
client.on(Events.InteractionCreate, async (interaction) => {
	// 1. First we check if the interaction is a slash command, if not we return.
	if (!interaction.isChatInputCommand()) return;

	// 2. Next we get the command name from the interaction.
	const command = interaction.client.commands.get(interaction.commandName);

	// 3. If the command doesn't exist, we log an error and return.
	if (!command) {
		console.error(
			`No command matching ${interaction.commandName} was found.`
		);
		return;
	}

	// 4. Now, try try and actually run the command
	try {
		await command.execute(interaction, client);
	} catch (error) {
		// 5. If error, log and tell the user
		console.error(error);
		await interaction.reply({
			content: 'There was an error while executing this command!',
			ephemeral: true,
		});
	}
});
```

Thats it for bot.js! Now we can move on to the next file.

# commands.js

Next, lets head over to handlers/commands.js

This file will handle the loading of all our commands.

1. First we add our imports

```js
const chillout = require('chillout');
const readdirRecursive = require('recursive-readdir');
const { resolve, relative } = require('path');
const { green, blue, magenta, red } = require('chalk');
```

-   chillout is a module that allows you to use async/await in for loops.
-   readdirRecursive is a module that allows you to recursively read a directory.

2. This will be a module export so we can use it in other files. All we need to do is pass in the client.

```js
module.exports = async (client) => {};
```

3. Now inside that method, lets start our code. First we get the commands path an files.

```js
let commandsPath = resolve('./commands');
let commandFiles = await readdirRecursive(commandsPath);
```

4. Next, we need to loop through all the files and load them.

```js
await chillout.forEach(commandFiles, (commandFile) => {
	// 1. Get start time for logging
	const startTime = Date.now();

	// 2. Get relative path so errors are easily human readable
	const relativePath = relative(__dirname, commandFile);

	// 3. Get the command file
	const command = require(commandFile);

	// 4. Check if the command has a name and execute method
	if ('data' in command && 'execute' in command) {
		// 5. If so, set it in the client.commands collection
		client.commands.set(command.data.name, command);
	} else {
		// 6. If not, log a warning
		console.log(
			`[WARNING] The command at ${relativePath} is missing a required "data" or "execute" property.`
		);
	}

	// 7. Log success
	console.log(
		`${green('[SUCCESS]')} Loaded command ${magenta(
			command.data.name
		)} in ${magenta(Date.now() - startTime)}${magenta('ms')}.`
	);

	// 7. Log even more success
	if (client.commands.size > 0) {
		console.log(
			`${blue('[INFO]')} ${magenta(
				client.commands.size
			)} slash commands loaded.`
		);
	} else {
		console.log(red('[ERROR] No slash commands loaded. UH OH RAGGY!'));
	}
});
```

Thats it! Now we can move on to the next file.

# events.js

Lets head over to handlers/events.js

1. First we add our imports

```js
const { readdirSync } = require('fs');
const { green, blue, magenta, red } = require('chalk');
```

2. We use a simple for loop to loop through all the events in the events folder. Very similar to how we are loading commands.

```js
readdirSync('./events/distube/').forEach((file) => {
	const event = require(`../events/distube/${file}`);
	let eventName = file.split('.')[0];
	client.distube.on(eventName, event.bind(null, client));
});
```

3. And again lets console log

```js
console.log(
	green('[SUCCESS]'),
	'Loaded all ' +
		magenta('events') +
		' in ' +
		magenta(Date.now() - startTime) +
		magenta('ms')
);
```

# Commands & Events

Now that we have our commands and events loaded, we can start working on the actual commands and events methods.

## play.js

Lets head over to commands/play.js

1. First we add our imports

```js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
```

2. Lets start by making our file a module export

```js
module.exports = {};
```

3. All future code in this section is inside the ladder { }

4. First we need to add our data. This is the information that will be displayed in the discord UI and sets the properties of our command

```js
	data: new SlashCommandBuilder()
		.setName('play')
		.setDescription('Plays a song from the source')
		.addStringOption((option) =>
			option
				.setName('search')
				.setDescription('The song to play')
				.setRequired(true)
		),
```

5. Now that we have our data, we need to add our execute function. This is the function that will be called when the command is executed. We pass the client and interaction as parameters as those are sent by us in bot.js.

```js
async execute (client, interaction) {
	// code here
}
```

6. Lets start by adding a try block

```js
try {
	// code here
} catch (error) {
	console.log(error);
}
```

7. Now we can start our code in the try block.

8. First lets check that the user added a search option. The setRequired(true) in the data will make it so that the user has to add a search option. However, we still need to check that the user added a search option.

```js
if (interaction.options.get('search')) {
}
```

9. All future code in this section is inside the ladder { }

10. Now we can tell the user we are searching for the song.

```js
await interaction.reply(
	`🔍 **Searching...** \`${interaction.options.getString('search')}\``
);
```

11. Next, we make sure that the user is in a voice channel and that the bot has permission to join the voice channel as well as speak in it.

```js
if (!channel) return interaction.editReply('You need to be in voice channel.');

if (
	!channel
		.permissionsFor(interaction.guild.members.me)
		.has(PermissionsBitField.Flags.Connect)
)
	return interaction.editReply(
		`I don't have perm \`CONNECT\` in ${channel.name} to join voice!`
	);

if (
	!channel
		.permissionsFor(interaction.guild.members.me)
		.has(PermissionsBitField.Flags.Speak)
)
	return interaction.editReply(
		`I don't have perm \`SPEAK\` in ${channel.name} to join voice!`
	);
```

12. Almost there! Now we've made it past all the validation, we need to get the search string from the interaction options.

```js
try {
	const string = interaction.options.getString('search');
```

13. Next we need to create our options object. This object will be passed to the play function. We need to pass in the member, textChannel, and interaction. This will allow DisTube to reply to the user and send messages to the channel.

```js
const options = {
	member: interaction.member,
	textChannel: interaction.channel,
	interaction,
};
```

14. Now we can play the song.

```js
await client.distube.play(
		interaction.member.voice.channel,
		string,
		options
	);
} catch (e) {
	console.log(e);
}
```

## Your turn!

Now that we've gone through the play command, its time for you to try and make the leave command. You can use the play command as a reference. If you get stuck, speak up!

Heres a hint:

_You don't need an any string options, and you don't need an options const for distube_

```js
await client.distube.voices.leave(interaction.guild);
```
