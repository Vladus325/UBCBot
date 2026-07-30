# UBCBot

Twitch music bot with web overlay and AI personality.

## Structure

- `src/bot/` - Bot logic (Twitch connection, commands, rewards, OBS integration)
- `src/music/` - Music queue and caching
- `src/overlay/` - Web server and overlay UI
- `src/config/` - Configuration files (commands, AI prompts, compliments)

## Features

- **AI Personality**: Interactive bot character (ai_prompt in config)
- **Music Queue System**: Automatic audio caching with cleanup (max 100 files or 500MB)
- **Twitch Channel Points Integration**: Reward-based music requests with different tiers (levels 1-3 with varying duration and skip costs)
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

TWITCH_TOKEN_MY=your_access_token
TWITCH_REFRESH_TOKEN_MY=your_refresh_token
TWITCH_SECRET_MY=your_secret

TWITCH_TOKEN=bot_access_token (can be same as MY)
TWITCH_REFRESH_TOKEN=bot_refresh_token (can be same as MY)

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
YT_DLP_EXTRA_ARGS=--cookies-from-browser chrome --extractor-args "youtube:visitor_data=YOUR_VISITOR_DATA"
```

### yt-dlp / YouTube cookies

If YouTube returns a bot verification or 429 error, set `YT_DLP_EXTRA_ARGS` with cookies or visitor data:

- `YT_DLP_PATH` can point to a custom `yt-dlp` binary
- `YT_DLP_EXTRA_ARGS` is appended to all yt-dlp invocations
- Example:
  - `YT_DLP_EXTRA_ARGS=--cookies-from-browser chrome`
  - `YT_DLP_EXTRA_ARGS=--cookies /path/to/youtube-cookies.txt`
  - `YT_DLP_EXTRA_ARGS=--extractor-args "youtube:visitor_data=YOUR_VISITOR_DATA"`

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

Overlay will be available at http://localhost:OVERLAY_PORT

## Commands

- `!play <url>` - Add song to queue (manual). Use rewards, also search working here.
- `!skip` - Skip current song (costs channel points based on reward level, or free mod+)
- `!np` - Show current song
- `!pause` - Pause/resume music
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
