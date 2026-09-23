const tmi = require('tmi.js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

let potProviderProcess = null;

function startPotProvider() {
    if ((process.env.YT_DLP_POT_PROVIDER || 'bgutil:http') === 'off') return;

    const serverPath = process.env.YT_DLP_POT_SERVER_PATH || path.join(
        process.cwd(),
        'tools',
        'bgutil-ytdlp-pot-provider',
        'server',
        'build',
        'main.js'
    );
 
    if (!fs.existsSync(serverPath)) {
        console.warn(`⚠️ bgutil POT provider не найден: ${serverPath}`);
        console.warn('Запустите scripts\\setup-bgutil-pot-provider.ps1 для установки провайдера.');
        return;
    }

    const providerUrl = new URL(process.env.YT_DLP_POT_SERVER_URL || 'http://127.0.0.1:4416');
    // порт приходит из URL операторского конфига; явная валидация диапазона
    const portNumber = Number(providerUrl.port || 4416);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        console.warn(`⚠️ Некорректный порт bgutil POT provider: ${providerUrl.port}`);
        return;
    }
    const port = String(portNumber);
    potProviderProcess = spawn(process.execPath, [serverPath, '--port', port], {
        cwd: path.dirname(serverPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    potProviderProcess.stdout.on('data', chunk => {
        console.log(`[bgutil] ${chunk.toString().trim()}`);
    });
    potProviderProcess.stderr.on('data', chunk => {
        console.error(`[bgutil] ${chunk.toString().trim()}`);
    });
    potProviderProcess.once('error', err => {
        console.error(`⚠️ Не удалось запустить bgutil POT provider: ${err.message}`);
    });
    potProviderProcess.once('exit', (code, signal) => {
        if (potProviderProcess) {
            console.warn(`⚠️ bgutil POT provider завершён (code=${code}, signal=${signal || 'none'})`);
            potProviderProcess = null;
        }
    });
}

function stopPotProvider() {
    if (!potProviderProcess) return;
    potProviderProcess.kill();
    potProviderProcess = null;
}

startPotProvider();

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ uncaughtException:', err.stack || err.message);
    stopPotProvider();
});

process.once('SIGINT', () => {
    stopPotProvider();
    process.exit(0);
});

process.once('SIGTERM', () => {
    stopPotProvider();
    process.exit(0);
});

const { refreshTokenPair } = require('./tokens');
const commandsManager = require('./commandsManager');
const musicQueue = require('../music/musicQueue');
const { cancelRedemption, patchRedemptionStatus } = require('./twitchApi');
const { connectDiscord } = require('./discordHook');
const { startStreamMonitoring } = require('./streamMonitor');

const CHAT_INTERNAL_ERROR = 'Внутренняя ошибка';

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

// Twitch EventSub WebSocket для отслеживания наград
const { startEventSub, setRedemptionHandler } = require('./rewards');

// Загружаем команды
commandsManager.loadCommands();

// 🎁 ID награды (музыка)
const MUSIC_REWARDS = {
    [process.env.SONG_REWARD_1_ID]: { level: 1 },
    [process.env.SONG_REWARD_2_ID]: { level: 2 },
    [process.env.SONG_REWARD_3_ID]: { level: 3 }
};

const MUSIC_CHAT_INTERNAL_ERROR = 'внутренняя ошибка';

async function cancelMusicRedemption(channel, username, reason, redemption) {
    try {
        await cancelRedemption({
            broadcasterId: process.env.BROADCASTER_ID,
            rewardId: redemption.rewardId,
            redemptionId: redemption.redemptionId,
            userId: redemption.userId,
            accessToken: process.env.TWITCH_TOKEN_MY,
            clientId: process.env.CLIENT_ID_MY
        });
        client.say(channel, `🎁 @${username}, заказ отменён (${reason === 'пустой запрос' ? reason : MUSIC_CHAT_INTERNAL_ERROR}), баланс возвращён.`);
    } catch (cancelErr) {
        console.error('Cancel redemption failed:', cancelErr);
        client.say(channel, `⚠️ @${username}, не удалось отменить заказ автоматически, проверьте вручную.`);
    }
}

// 🎵 Музыкальные награды приходят через EventSub: настоящие redemptionId
// для возврата баллов вместо message-id из чата
setRedemptionHandler(async ({ rewardId, redemptionId, userId, login, displayName, input }) => {
    const reward = MUSIC_REWARDS[rewardId];
    if (!reward) return false;

    const channel = process.env.CHANNEL_NAME;
    const trimmedInput = (input || '').trim();
    if (!trimmedInput) {
        await cancelMusicRedemption(channel, login, 'пустой запрос', { rewardId, redemptionId, userId });
        return true;
    }

    try {
        const redemptionData = { rewardId, redemptionId, userId };
        const track = await musicQueue.add(trimmedInput, login, reward.level, redemptionData);
        client.say(channel, `🎵 ${displayName || login} добавил: ${track.title} (${reward.level} ур.)`);
        // закрываем редемпшен в панели Twitch (не критично, если не выйдет)
        patchRedemptionStatus({
            broadcasterId: process.env.BROADCASTER_ID,
            rewardId,
            redemptionId,
            status: 'FULFILLED',
            accessToken: process.env.TWITCH_TOKEN_MY,
            clientId: process.env.CLIENT_ID_MY
        }).catch(err => console.warn('Не удалось подтвердить редемпшен:', err.message));
    } catch (e) {
        console.error('Music order failed:', e.message);
        await cancelMusicRedemption(channel, login, e.message, { rewardId, redemptionId, userId });
    }
    return true;
});

startEventSub();

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
        client.say(process.env.CHANNEL_NAME, `🎁 @${track.requestedBy}, заказ отменён (${CHAT_INTERNAL_ERROR}), баланс возвращён.`);
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
        // Музыкальные награды обрабатываются через EventSub (rewards.js);
        // сообщение редемпшена в чате просто игнорируем, чтобы не задваивать заказы

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
