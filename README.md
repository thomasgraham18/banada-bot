# 🍁 Banada Bot

Built by:

-   [Thomas]
-   [Jacques]

Banada Bot is a feature-rich DiscordJS v14 implementation that is:

-   👟Fast👟
-   ⚡Efficient⚡
-   ✨Magic✨

## 🚀 Setup

Requires [Node.js] 24.15 or newer. Everything is run from the `src` folder.

```bash
cd src
npm install          # also downloads FFmpeg and the Opus encoder
npm run check        # checks the install without logging in to Discord
npm run deploy       # registers the slash commands (run again after changing any command)
npm start
```

Create `src/config.json` (it is gitignored, never commit it):

```json
{
	"DISCORD_TOKEN": "",
	"CLIENT_ID": "",
	"GUILD_ID": "",
	"OWNER_ID": "",
	"EMBED_COLOUR": "580476",
	"LEAVE_EMPTY": "false",
	"LEAVE_EMPTY_TIME": "60000",
	"LEAVE_FINISH": "false",
	"LEAVE_STOP": "false",
	"SPOTIFY_TOGGLE": "true",
	"SPOTIFY_ID": "",
	"SPOTIFY_SECRET": "",
	"COMMANDS_CHANNEL_ID": ""
}
```

| Key | Meaning |
|---|---|
| `LEAVE_EMPTY`, `LEAVE_EMPTY_TIME` | Leave the voice channel once it has had no listeners for this many milliseconds. |
| `LEAVE_FINISH`, `LEAVE_STOP` | Leave when the queue ends, or when `/stop` is used. |
| `SPOTIFY_TOGGLE` | `"true"` uses the Spotify API credentials. Otherwise Spotify links are read without them, which limits long playlists. |
| `COMMANDS_CHANNEL_ID` | Optional. Channel that receives the command list on startup and once a day. |

Optional web panel keys (add them to `config.json`, or set them as environment variables):

| Key | Meaning |
|---|---|
| `WEB_PORT` | Panel port, default `3000`. |
| `WEB_HOST` | Bind address, default `127.0.0.1` (this PC only). Docker uses `0.0.0.0`. |
| `WEB_TOKEN` | Panel password. If unset, one is generated into `src/data/panel.json`. |
| `WEB_DISABLED` | `"true"` turns the panel off. |
| `CLIENT_SECRET` | Optional. Your app's OAuth2 client secret (Developer Portal → OAuth2). Enables **Connect Discord** on the panel's Permissions page, so moderators/admins you add there see staff commands in Discord's `/` menu. Also add `<PANEL_URL>/oauth/callback` under OAuth2 → Redirects. |
| `PANEL_URL` | Optional. The panel's address as your browser sees it (default `http://localhost:<WEB_PORT>`). Used for the OAuth redirect. |

## 🖥️ Web panel

On startup the bot prints a link such as `http://127.0.0.1:3000/#token=…`. Open it to get:

-   **Dashboard**: bot status and, for each server, the current queue with play/pause, skip, previous, stop, shuffle, loop, autoplay, volume and removing upcoming songs.
-   **Reaction roles**: build menus of colour roles (solid, gradient, holographic) and role-icon roles, then create the roles and post the menus. Members react to pick a role; in an "exclusive" group, picking another role swaps it. Groups can be limited to members with certain roles (e.g. Server Booster).
-   **Settings**: embed colour, default volume, the leave-on-empty/finish/stop options, the rotating custom statuses and the daily command-list channel. Changes apply immediately, with no restart.
-   **Server**: per-server settings for every feature package: moderation roles and log channels, staff
    roles, fake permissions, `/ignore` and `/access` rules, punishment messages, honeypots, chat filters and
    words, welcome/goodbye/boost/sticky messages, booster roles, suggestions, autoresponders, automation,
    auto roles, VoiceMaster, levels and level roles, starboard/clownboard and bump reminders. Saved values are
    checked the same way the slash commands check them, and apply immediately. Message fields have a preview.
    Giveaways, cases, leaderboards, timers, counters and reaction/button roles are listed read-only; create
    those with their slash commands.
-   **Commands** and **Activity** (recent reaction-role picks).

Settings and reaction roles are saved in `src/data/` (gitignored). Values in `config.json` are only the starting defaults.

Reaction roles need these permissions in the menu channel: View Channel, Send Messages, Read Message History, Add Reactions, Use External Emoji, plus Manage Messages to tidy members' reactions. The bot also needs **Manage Roles**, and its own role must sit above the colour and icon roles. Gradients need the *Enhanced Role Styles* boost perk and role icons need boost level 2. Without them, the roles still work, just as solid colours or without icons.

Optional: `src/cookie.json`, a YouTube cookie export (an array of `{ name, value, ... }` objects, the format the EditThisCookie extension exports). It is only needed if YouTube asks the bot to sign in. Use a throwaway account. Expired files are ignored.

### Troubleshooting

-   `npm run check -- "song name"` tests playback end to end without Discord: search, stream URL, FFmpeg, Opus.
-   Set the environment variable `DEBUG_DISTUBE=1` to print DisTube and FFmpeg internals.
-   Docker: build from `src` with `docker build -t banadabot .`

The November 2026 repair is written up in [docs/UPGRADE-2026-11.md](docs/UPGRADE-2026-11.md).

## 🛡️ Server management commands

A re-implementation of the Server Management slash commands from bleed.bot (`/settings`, `/filter`,
`/levels`, `/giveaways`, `/starboard`, `/voicemaster`, …). Design notes are in
[docs/bleed-server-mgmt-guide](docs/bleed-server-mgmt-guide/GUIDE.md).

-   `src/core/` is the shared framework: SQLite (built-in `node:sqlite`, file `src/data/bot.db`),
    a command router with permission gates and `/access` checks, message scripts, a persistent
    scheduler and a punishment service. Its API is described in [CORE.md](docs/bleed-server-mgmt-guide/CORE.md).
-   `src/features/<package>/` holds one package per command family. They are loaded automatically.
-   `npm test` runs the offline unit tests. `npm run check` also validates every command tree.

**Required:** in the Discord Developer Portal → your app → Bot, enable the privileged
**Message Content** and **Server Members** intents. Without them Discord refuses the login.
Run `npm run deploy -- --guild` while testing (instant, to `GUILD_ID` only), then `npm run deploy` for
every server.

## 📑 Implemented Features

-   [x] Embeds
-   [x] Moderation
-   [x] Music Player
-   [x] SoundCloud Support
-   [x] Spotify Support
-   [x] YouTube Support

## 💻 Tech

Banada Bot uses several open-source projects to work properly:

-   [Chalk] - Pretty errors and initialization!
-   [DiscordJS-v14] - The main tech!
-   [DisTube] - The power behind the music! With its YouTube, Spotify and SoundCloud plugins.
-   [ffmpeg] - Audio, audio, audio! Bundled through ffmpeg-static.
-   [@discordjs/opus] - Opus encoding for voice.

## 🗨️ Command list

### 🛠️ Moderation

-   [x] help
-   [x] kick
-   [x] restart
-   [x] embedjson
-   [x] embedcustom

### 🎶 Music

-   [x] autoplay
-   [x] banada
-   [x] clearQueue
-   [x] foward
-   [x] join
-   [x] leave
-   [x] loop
-   [x] loopQueue
-   [x] move
-   [x] nowPlaying
-   [x] pause
-   [x] play
-   [x] playSkip
-   [x] playTop
-   [x] previous
-   [x] queue
-   [x] remove
-   [x] replay
-   [x] resume
-   [x] rewind
-   [x] seek
-   [x] shuffle
-   [x] skip
-   [x] skipTo
-   [x] stop
-   [x] volume

`play`, `playSkip` and `playTop` suggest YouTube results as you type.

While music plays, a single player panel shows the current song, progress and what is up next, with buttons for previous, pause, skip, stop, queue, shuffle, loop, autoplay and volume. It updates in place; `nowPlaying` brings it back to the bottom of the chat. Give the bot the Set Voice Channel Status permission to also show the song under the voice channel's name.

[//]: #
[thomas]: https://github.com/thomasgraham18
[jacques]: https://github.com/jacques-jd
[git-repo-url]: https://github.com/thomasgraham18/AT-Project
[node.js]: https://nodejs.org
[discordjs-v14]: https://discord.js.org/#/
[chalk]: https://www.npmjs.com/package/chalk
[distube]: https://www.npmjs.com/package/distube
[ffmpeg]: https://ffmpeg.org
[@discordjs/opus]: https://www.npmjs.com/package/@discordjs/opus
