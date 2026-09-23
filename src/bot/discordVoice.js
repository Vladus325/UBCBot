const fs = require('fs');
const net = require('net');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { MessageFlags } = require('discord.js');
const {
    joinVoiceChannel,
    getVoiceConnection,
    getVoiceConnections,
    createAudioPlayer,
    createAudioResource,
    entersState,
    StreamType,
    AudioPlayerStatus,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const musicQueue = require('../music/musicQueue');

// Трансляция заказов музыки в голосовой канал Discord.
// Один активный стрим на процесс бота: слушатели получают тот же трек
// и ту же позицию, что и overlay в OBS.

const LEAVE_AFTER_IDLE_MS = 15000;
// Discord выдаёт случайный порт медиасервера на каждое подключение;
// некоторые сети (DPI провайдера) пропускают только часть портов (443, 2053,
// 2087...), остальные молча дропаются. Поэтому проверяем порт TCP-пробой и
// переподключаемся, пока не выпадет доступный.
const JOIN_ATTEMPTS = 5;
const READY_TIMEOUT_MS = 8000;
const ENDPOINT_PROBE_MS = 2500;

ffmpeg.setFfmpegPath(ffmpegPath);

const player = createAudioPlayer();
let currentTranscode = null;
let leaveTimer = null;
let lastVoiceChannel = null;

function firstVoiceConnection() {
    const connections = [...getVoiceConnections().values()];
    return connections[0] || null;
}

function clearLeaveTimer() {
    if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
    }
}

function scheduleLeave() {
    clearLeaveTimer();
    leaveTimer = setTimeout(() => {
        leaveTimer = null;
        const connection = firstVoiceConnection();
        if (connection && !musicQueue.current) {
            stopVoice(connection, 'очередь пуста');
        }
    }, LEAVE_AFTER_IDLE_MS);
    if (typeof leaveTimer.unref === 'function') {
        leaveTimer.unref();
    }
}

function killTranscode() {
    if (!currentTranscode) return;
    try {
        currentTranscode.kill('SIGKILL');
    } catch {
        // процесс уже завершён
    }
    currentTranscode = null;
}

function stopVoice(connection, reason) {
    clearLeaveTimer();
    killTranscode();
    try {
        player.stop(true);
    } catch {
        // плеер уже остановлен
    }
    try {
        connection.destroy();
    } catch {
        // соединение уже закрыто
    }
    lastVoiceChannel = null;
    console.log(`⏹ Трансляция музыки в Discord остановлена (${reason})`);
}

// Уходим из канала, если слушатели разбежались, чтобы не кодировать в пустоту
const aloneCheckTimer = setInterval(() => {
    const connection = firstVoiceConnection();
    if (!connection || !lastVoiceChannel) return;
    const humans = [...lastVoiceChannel.members.values()].filter(member => !member.user.bot);
    if (humans.length === 0) {
        stopVoice(connection, 'в канале не осталось слушателей');
    }
}, 60000);
if (typeof aloneCheckTimer.unref === 'function') {
    aloneCheckTimer.unref();
}

// Стрим трека из кэша заказов: ffmpeg кодирует в opus/ogg,
// @discordjs/voice пропускает opus-пакеты без перекодирования
function startTrackStream(seekSec = 0) {
    clearLeaveTimer();
    killTranscode();

    const state = musicQueue.getState();
    const cacheFile = musicQueue.currentCacheFile;
    if (!state || !cacheFile || !fs.existsSync(cacheFile)) {
        scheduleLeave();
        return;
    }

    const seek = Math.max(0, Math.floor(seekSec));
    const transcode = ffmpeg(cacheFile)
        .on('error', err => {
            console.error(`Ошибка ffmpeg Discord-стрима (поз. ${seek}с):`, err.message);
            if (currentTranscode === transcode) {
                currentTranscode = null;
                scheduleLeave();
            }
        });

    const stream = transcode
        .seekInput(seek)
        .noVideo()
        .audioCodec('libopus')
        .audioBitrate('128k')
        .audioFrequency(48000)
        .audioChannels(2)
        .format('ogg')
        .pipe({ end: true });

    currentTranscode = transcode;
    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
    player.play(resource);
    console.log(`🔊 Discord-стрим: «${state.title}» с позиции ${seek}с`);
}

function probeTcpPort(host, port, timeoutMs = ENDPOINT_PROBE_MS) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port, family: 4 });
        const finish = ok => {
            clearTimeout(timer);
            try { socket.destroy(); } catch { /* уже закрыт */ }
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

// Оборачиваем адаптер гильдии: onVoiceServerUpdate/onVoiceStateUpdate —
// диспетчеры (принимают payload). Логируем выданный медиасервер и быстро
// отсеиваем недоступные порты.
function buildAdapterCreator(guild) {
    const guildAdapter = guild.voiceAdapterCreator;
    let lastEndpoint = null;
    let lastEndpointOk = null;

    const creator = methods => guildAdapter({
        ...methods,
        onVoiceServerUpdate: data => {
            lastEndpoint = data.endpoint || null;
            lastEndpointOk = null;
            console.log(`📡 Discord voice: медиасервер ${lastEndpoint || 'без эндпоинта'}`);
            if (lastEndpoint) {
                const [host, portStr] = lastEndpoint.split(':');
                const port = Number(portStr) || 443;
                probeTcpPort(host, port).then(ok => {
                    lastEndpointOk = ok;
                    if (!ok) {
                        console.warn(`⚠️ Discord voice: порт ${port} недоступен из этой сети, переподключаюсь за новым`);
                    }
                });
            }
            methods.onVoiceServerUpdate(data);
        },
        onVoiceStateUpdate: data => {
            methods.onVoiceStateUpdate(data);
        }
    });
    creator.getLastEndpoint = () => ({ endpoint: lastEndpoint, reachable: lastEndpointOk });
    return creator;
}

function attachConnectionHandlers(connection) {
    const startedAt = Date.now();
    connection.on('stateChange', (oldState, newState) => {
        console.log(`📡 Discord voice: ${oldState.status} -> ${newState.status} (+${Date.now() - startedAt}мс)`);
    });
    connection.on('error', err => {
        console.error('❌ Discord voice connection error:', err.message);
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            // даём библиотеке шанс переподключиться (стандартный паттерн @discordjs/voice)
            await entersState(connection, VoiceConnectionStatus.Signalling, 5000);
            await entersState(connection, VoiceConnectionStatus.Ready, 5000);
        } catch {
            stopVoice(connection, 'связь потеряна');
        }
    });
}

// Пытаемся достичь Ready несколько раз: Discord на каждый заход выдаёт
// новый порт медиасервера, так что блокированные DPI порты перебираются
async function joinAndSubscribe(guild, voiceChannel) {
    let lastError = null;

    for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt += 1) {
        const adapterCreator = buildAdapterCreator(guild);
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator,
            selfDeaf: false
        });
        attachConnectionHandlers(connection);
        connection.subscribe(player);

        // Проба порта: если он заблокирован — reject почти сразу (не ждём таймаут Ready).
        // Доступный порт — промис не резолвится, побеждает entersState.
        const blockedProbe = new Promise((_, reject) => {
            const poll = setInterval(() => {
                const { endpoint, reachable } = adapterCreator.getLastEndpoint();
                if (endpoint && reachable === false) {
                    clearInterval(poll);
                    reject(new Error(`порт ${endpoint.split(':')[1] || '443'} недоступен из сети`));
                }
                if (reachable === true) {
                    clearInterval(poll);
                }
            }, 250);
            setTimeout(() => clearInterval(poll), READY_TIMEOUT_MS + 1500);
        });

        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS),
                blockedProbe
            ]);
            return connection;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Подключение к голосовому каналу (попытка ${attempt}/${JOIN_ATTEMPTS}) не удалось: ${err.message}`);
            try {
                connection.destroy();
            } catch {
                // уже закрыто
            }
            // пауза: Discord должен успеть обработать выход, иначе следующий
            // join молча игнорируется (застревает в signalling)
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    throw lastError || new Error('голосовой канал не отвечает');
}

// Синхронизация стрима с очередью заказов
musicQueue.on('trackStart', () => {
    if (firstVoiceConnection()) {
        startTrackStream(0);
    } else {
        clearLeaveTimer();
    }
});

musicQueue.on('pause', () => {
    player.pause();
});

musicQueue.on('play', () => {
    player.unpause();
});

musicQueue.on('skip', () => {
    // если дальше что-то играет, придёт trackStart; иначе уйдём по таймеру
    if (!musicQueue.current) {
        scheduleLeave();
    }
});

player.on(AudioPlayerStatus.Idle, () => {
    if (!musicQueue.current) {
        scheduleLeave();
    }
});

player.on('error', err => {
    console.error('Ошибка Discord voice player:', err.message);
    scheduleLeave();
});

async function handleStreamAudioCommand(interaction) {
    if (!interaction.inGuild()) {
        await interaction.reply({ content: 'Команда работает только на сервере.', flags: MessageFlags.Ephemeral });
        return;
    }

    const existing = getVoiceConnection(interaction.guildId) || firstVoiceConnection();
    if (existing) {
        stopVoice(existing, 'команда');
        await interaction.reply({ content: '⏹ Трансляция музыки остановлена.', flags: MessageFlags.Ephemeral });
        return;
    }

    const state = musicQueue.getState();
    if (!state || !musicQueue.currentCacheFile) {
        await interaction.reply({ content: 'Сейчас ничего не играет в заказе музыки.', flags: MessageFlags.Ephemeral });
        return;
    }

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
        await interaction.reply({ content: 'Зайди в голосовой канал, чтобы слушать заказы.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        await joinAndSubscribe(interaction.guild, voiceChannel);

        lastVoiceChannel = voiceChannel;
        startTrackStream(state.elapsed);

        await interaction.editReply(`🔊 Транслирую «${state.title}» в #${voiceChannel.name}`);
    } catch (err) {
        console.error('Не удалось начать трансляцию в Discord:', err.message);
        const connection = getVoiceConnection(interaction.guildId) || firstVoiceConnection();
        if (connection) {
            stopVoice(connection, 'ошибка подключения');
        }
        await interaction.editReply('Не удалось подключиться к голосовому каналу (подробности в логе бота).');
    }
}

module.exports = {
    handleStreamAudioCommand
};
