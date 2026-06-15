const tmi = require('tmi.js');

require('dotenv').config();

const { refreshTokenPair } = require('./tokens');
const commandsManager = require('./commandsManager');
const musicQueue = require('../music/musicQueue');
const { cancelRedemption } = require('./twitchApi');
const { connectDiscord } = require('./discordHook');
const { startStreamMonitoring } = require('./streamMonitor');

async function refreshTwitchToken() {
    await refreshTokenPair('TWITCH_REFRESH_TOKEN', 'TWITCH_TOKEN');
    await refreshTokenPair('TWITCH_REFRESH_TOKEN_MY', 'TWITCH_TOKEN_MY');
}

// Проверка токена при старте
refreshTwitchToken().catch(err => {
    console.error('⚠️ Ошибка обновления токена при старте, продолжаем с текущими токенами:', err.message);
});

// подключение к OBS (асинхронно, не блокирует запуск)
const { connectOBS } = require('./obsHook');
connectOBS().catch(err => {
    console.error('⚠️ Не удалось подключиться к OBS при старте:', err.message);
});

// подключение к Discord (асинхронно, не блокирует запуск)
connectDiscord().catch(err => {
    console.error('⚠️ Не удалось подключиться к Discord при старте:', err.message);
});

// запуск мониторинга статуса стрима
startStreamMonitoring();

// запуск overlay
const { startOverlayServer } = require('../overlay/overlayServer');
startOverlayServer();

// Twitch PubSub для отслеживания наград
const { startPubSub } = require('./rewards');
startPubSub();

// Загружаем команды
commandsManager.loadCommands();

// 🎁 ID награды (музыка)
const MUSIC_REWARDS = {
    [process.env.SONG_REWARD_1_ID]: { level: 1, maxDuration: 180, skipCost: 1, cost: 125 },
    [process.env.SONG_REWARD_2_ID]: { level: 2, maxDuration: 420, skipCost: 3, cost: 250 },
    [process.env.SONG_REWARD_3_ID]: { level: 3, maxDuration: 1800, skipCost: 5, cost: 500 }
};

// Обработка ошибок загрузки музыки - возвращаем баллы
musicQueue.on('downloadError', async (errorData) => {
    const { track, reason } = errorData;
    if (!track || !track.redemptionData) return;

    try {
        const { rewardId, redemptionId, userId } = track.redemptionData;
        await cancelRedemption({
            broadcasterId: process.env.BROADCASTER_ID,
            rewardId,
            redemptionId,
            userId,
            accessToken: process.env.TWITCH_TOKEN_MY,
            clientId: process.env.CLIENT_ID_MY
        });
        console.log(`✅ Баллы возвращены для ${track.requestedBy} (${reason})`);
        client.say(process.env.CHANNEL_NAME, `🎁 @${track.requestedBy}, заказ отменён (${reason}), баланс возвращён.`);
    } catch (cancelErr) {
        console.error('❌ Не удалось отменить заказ:', cancelErr.message);
        client.say(process.env.CHANNEL_NAME, `⚠️ @${track.requestedBy}, не удалось отменить заказ автоматически, проверьте вручную.`);
    }
});

// Создаём клиента
const client = new tmi.Client({
    options: { debug: true },
    connection: { reconnect: true, secure: true },
    identity: { username: process.env.BOT_USERNAME, password: 'oauth:' + process.env.TWITCH_TOKEN },
    channels: [process.env.CHANNEL_NAME]
});

client.connect().catch(console.error);

///////////////////////////////////////////////////////////////////////////////////////////////////////////

// 💬 обработка сообщений
client.on('message', async (channel, tags, message, self) => {
    if (self) return;

    // console.log(tags);

    const args = message.split(" ");
    const command = args[0].toLowerCase();

    try {
        const reward = MUSIC_REWARDS[tags['custom-reward-id']];
        if (reward) {
            const username = tags.username;
            const redemptionId = tags['id'] || tags['redemption-id'];
            const rewardId = tags['custom-reward-id'];
            const userId = tags['user-id'];

            const cancelAndNotify = async (reason) => {
                try {
                    await cancelRedemption({
                        broadcasterId: process.env.BROADCASTER_ID,
                        rewardId,
                        redemptionId,
                        userId,
                        accessToken: process.env.TWITCH_TOKEN_MY,
                        clientId: process.env.CLIENT_ID_MY
                    });
                    client.say(channel, `🎁 @${username}, заказ отменён (${reason}), баланс возвращён.`);
                } catch (cancelErr) {
                    console.error('Cancel redemption failed:', cancelErr);
                    client.say(channel, `⚠️ @${username}, не удалось отменить заказ автоматически, проверьте вручную.`);
                }
            };

            if (!message) {
                await cancelAndNotify('пустой запрос');
                return;
            }

            try {
                const redemptionData = { rewardId, redemptionId, userId };
                const track = await musicQueue.add(message, username, reward.level, redemptionData);
                client.say(channel, `🎵 ${username} добавил: ${track.title} (${reward.level} ур.)`);
            } catch (e) {
                await cancelAndNotify(e.message);
            }
        }

        // 📌 Обычные команды
        if (commandsManager.hasCommand(command)) {
            const response = await commandsManager.getCommandResponse(command, tags, channel, args.slice(1));
            client.say(channel, response);
        }

        // 📜 Список команд
        if (command === "!commands") {
            const list = Object.keys(commandsManager.getCommands()).join(", ");
            client.say(channel, `📜 Команды: ${list}`);
        }

        // 🔄 Восстановление наград из бэкапа
        // if (command === '!restorerewards') {
        //     try {
        //         await restoreRewards({
        //             broadcasterId: process.env.BROADCASTER_ID,
        //             accessToken: process.env.TWITCH_TOKEN_MY,
        //             clientId: process.env.CLIENT_ID_MY
        //         });

        //         client.say(channel, '✅ Награды восстановлены');
        //     } catch (e) {
        //         console.error(e);
        //         client.say(channel, '❌ Ошибка восстановления');
        //     }
        // }

        // 🤖 Ответ на упоминание бота (@theUnluckyBlackCat)
        const botMention = `@${process.env.BOT_USERNAME.toLowerCase()}`;
        if (message.toLowerCase().startsWith(botMention)) {
            const userMessage = message.slice(botMention.length).trim();
            const response = await commandsManager.getCommandResponse('!бот', tags, channel, userMessage.split(' '));
            client.say(channel, response);
        }

    } catch (err) {
        console.error('Ошибка:', err);
    }
});
