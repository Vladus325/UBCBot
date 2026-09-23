# UBCBot

Twitch music bot with web overlay and AI personality.

## Structure

- `src/bot/` - Bot logic (Twitch connection, commands, rewards, OBS integration)
- `src/music/` - Music queue and caching
- `src/overlay/` - Web server and overlay UI
- `src/config/` - Configuration files (commands, AI prompts, compliments)

## Features

- **AI Personality**: Interactive bot character (ai_prompt in config)
- **Music Queue System**: Tracks are downloaded right when ordered (prefetch), so transitions between songs are instant. Queue limits and automatic audio cache cleanup (max 100 files or 500MB, configurable)
- **Twitch Channel Points Integration**: Rewards arrive via EventSub WebSocket (music requests with different tiers, wheel, OBS media). Refunds points on download errors
- **OBS Integration**: Automatic scene switching and media playback for rewards
- **Discord Integration**: Automatic notifications when stream goes live
- **Web Overlay**: Real-time updates with smooth animations for current song display
- **Browser-based Audio Playback**: Seamless music streaming
- **Twitch Chat Integration**: Custom commands, compliments, dice rolls, and more
- **Database Storage**: Persistent data for user interactions and rewards
- **Token Management**: Automatic Twitch token refresh

## Installation

```bash
npm install
```

## Configuration

Create `.env` file with:

```
//Twitch
BROADCASTER_ID=your_broadcaster_id
CLIENT_ID_MY=your_client_id

// TWITCH_TOKEN_MY needs the channel:read:redemptions scope
// (EventSub WebSocket for channel point redemptions)
TWITCH_TOKEN_MY=your_access_token
TWITCH_REFRESH_TOKEN_MY=your_refresh_token
TWITCH_SECRET_MY=your_secret

TWITCH_TOKEN=bot_access_token (can be same as MY)
TWITCH_REFRESH_TOKEN=bot_refresh_token (can be same as MY)

//Wheel reward
WHEEL_REWARD_ID=created_reward_id
WHEEL_REWARD_TITLE=Крутить колесо
WHEEL_REWARD_COST=500
// Настройки колеса задаются на http://localhost:OVERLAY_PORT/wheel

//OBS
OBS_PASSWORD=your_obs_websocket_password
OVERLAY_PORT=3000

//Discord (опционально)
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_ID=your_discord_channel_id

//For SR managment
SONG_REWARD_1_ID=reward_id_level_1
SONG_REWARD_2_ID=reward_id_level_2
SONG_REWARD_3_ID=reward_id_level_3

//AI stuff
AI_BASE_URL=...
AI_API_KEY=...
AI_MODEL=...

//Optional yt-dlp configuration
YT_DLP_PATH=path/to/yt-dlp.exe
YT_DLP_COOKIES=cookies.txt
YT_DLP_POT_PROVIDER=bgutil:http
YT_DLP_POT_SERVER_URL=http://127.0.0.1:4416
YT_DLP_EXTRA_ARGS=

//Optional music queue limits
MUSIC_MAX_QUEUE=15        // max tracks in queue
MUSIC_MAX_PER_USER=2      // max tracks per user (queue + current)
MUSIC_CACHE_MAX_FILES=100 // audio_cache file limit
MUSIC_CACHE_MAX_MB=500    // audio_cache size limit
```

### yt-dlp / YouTube cookies

The bot automatically adds `cookies.txt` from the project root when it exists. You can override its path with `YT_DLP_COOKIES`.
PO Tokens are generated automatically by the [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) HTTP server:

- `YT_DLP_PATH` can point to a custom `yt-dlp` binary
- `YT_DLP_COOKIES` points to a Netscape-format YouTube cookies file
- `YT_DLP_POT_PROVIDER` enables the provider; use `off` to disable it
- `YT_DLP_POT_SERVER_URL` points to the local provider server
- `YT_DLP_EXTRA_ARGS` can still be used for custom yt-dlp options; explicit `--cookies`, `--cookies-from-browser` or `po_token=` options take precedence

Install the provider on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-bgutil-pot-provider.ps1
```

The installer clones version `1.3.1`, builds the HTTP server, and installs the yt-dlp plugin under `%APPDATA%\yt-dlp\plugins`. `run_bot.bat` starts the provider automatically when it has been installed.

For more details, check the yt-dlp docs and the error message returned by the bot.

### Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a new bot
4. Copy the bot token and paste it as `DISCORD_TOKEN` in `.env`
5. Give the bot permissions: `Send Messages`, `Embed Links`
6. Add the bot to your Discord server
7. In Discord, right-click on a channel and select "Copy Channel ID"
8. Paste it as `DISCORD_CHANNEL_ID` in `.env`

When your Twitch stream goes live, the bot will automatically send a notification to the configured Discord channel with stream details and a link to watch.

## Running

```bash
npm start
```

Tests: `npm test`

Overlay will be available at http://localhost:OVERLAY_PORT
OBS widget will be available at http://localhost:OVERLAY_PORT/obs or http://localhost:OVERLAY_PORT/widget
Wheel widget will be available at http://localhost:OVERLAY_PORT/wheel or http://localhost:OVERLAY_PORT/wheel-widget

The wheel reads weighted options from `src/config/wheel_config.txt`. Each line uses the format `Название | вес`. Duration, local music and image are saved from `http://localhost:OVERLAY_PORT/wheel` and used by Twitch reward activations.
To create the Twitch reward once, run `npm run create:wheel-reward`, then put the printed ID into `WHEEL_REWARD_ID` in `.env` and restart the bot.

## Commands

- `!play <запрос>` - Add song to queue (manual, free, level 1 limits). Accepts URL or search query
- `!skip` - Skip current song (costs channel points based on reward level, or free mod+)
- `!np` - Show current song
- `!queue` / `!очередь` - Show current song and upcoming tracks
- `!pause` - Pause/resume music (mod+)
- `!resume` - Resume music (mod+)
- `!комплимент` - Get a random compliment
- `!d20` / `!d100` - Roll dice (also have point system where you can get ban for 1 or points 20,100)
- `!бот` - Chat with AI personality (or you can just @tag him)
- `!discord` - Discord invite link
- `!steam` - Steam profile link
- `!донат` - Donation links
- `!какзаказатьбс` - Beat Saber map ordering guide
- `!luckpoints` - Check luck points
- `!vrmode` / `!srmode` - VR/SR mode status (hides/shows rewards)

## Music Reward Tiers

- **Level 1**: 125 points, max 3 min, skip cost 1 lpoint
- **Level 2**: 250 points, max 7 min, skip cost 3 lpoints  
- **Level 3**: 500 points, max 30 min, skip cost 5 lpoints

(suggested cost)

Rewards automatically trigger OBS media playback and refund points on download errors.
