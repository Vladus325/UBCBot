const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { handleStreamAudioCommand } = require('./discordVoice');

let discordClient = null;
let notificationChannel = null;
let healthTimer = null;
let connecting = false;

const DISCORD_MAX_ATTEMPTS = Number(process.env.DISCORD_RETRY_ATTEMPTS || 5);
const DISCORD_RETRY_DELAY_MS = Number(process.env.DISCORD_RETRY_DELAY_MS || 5000);
const HEALTH_CHECK_MS = Number(process.env.DISCORD_HEALTH_CHECK_MS || 60000);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function discordConfigured() {
    return Boolean(process.env.DISCORD_TOKEN && process.env.DISCORD_CHANNEL_ID);
}

// DISCORD_CHANNEL_ID приходит из .env (конфиг оператора), не из чата;
// discord.js строит запрос только к discord.com, а ID — числовой snowflake.
// Валидация отсекает мусор из конфига до похода в API Discord.
function validDiscordId(id) {
    return /^\d{16,20}$/.test(String(id || ''));
}

async function resolveNotificationChannel(client) {
    const channelId = process.env.DISCORD_CHANNEL_ID;
    if (!validDiscordId(channelId)) {
        console.error('❌ DISCORD_CHANNEL_ID некорректен: ожидается числовой ID канала Discord (правый клик по каналу → «Копировать ID канала»)');
        notificationChannel = null;
        return null;
    }
    let channel = client.channels.cache.get(channelId);
    if (!channel) {
        try {
            channel = await client.channels.fetch(channelId);
        } catch (fetchErr) {
            console.error('❌ Ошибка при fetch канала:', fetchErr.message);
        }
    }
    notificationChannel = channel && channel.isTextBased() ? channel : null;
    return notificationChannel;
}

function buildDiscordClient() {
    return new Client({
        // GuildVoiceStates нужен для трансляции музыки в голосовые каналы
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.DirectMessages
        ],
        ws: {
            handshakeTimeout: Number(process.env.DISCORD_WS_HANDSHAKE_TIMEOUT_MS || 60000)
        },
        rest: {
            timeout: 30000,
            retries: 2,
            version: 10
        }
    });
}

// Периодическая проверка: если клиент потерялся (сеть, краш шарда,
// неудачный старт) — поднимаем заново. Это не даёт боту "пропадать"
// в Discord до ручного перезапуска.
function scheduleHealthCheck() {
    if (healthTimer) return;
    healthTimer = setInterval(async () => {
        if (!discordConfigured() || connecting) return;
        if (discordClient && discordClient.isReady()) return;

        console.warn('⚠️ Discord не подключен, попытка восстановления...');
        try {
            await connectDiscord();
        } catch (err) {
            console.error('❌ Не удалось восстановить Discord:', err.message);
        }
    }, HEALTH_CHECK_MS);
    if (typeof healthTimer.unref === 'function') {
        healthTimer.unref();
    }
}

// /stream-audio обычно уже зарегистрирована; проверяем и создаём, если нет,
// чтобы фича работала на чистой установке
async function ensureStreamAudioCommand(client) {
    const commandData = {
        name: 'stream-audio',
        description: 'Слушать музыку из заказов в голосовом канале'
    };
    try {
        // guilds.cache.get — поиск в in-memory кэше (без сети); дальше запросы
        // идут только к discord.com c фиксированным хостом, ID из .env
        // оператора. Snowflake-проверка отсекает мусор из конфига.
        const guildId = process.env.DISCORD_GUILD_ID;
        if (guildId && !validDiscordId(guildId)) {
            console.warn('⚠️ DISCORD_GUILD_ID некорректен (ожидается числовой ID сервера), команду /stream-audio регистрирую глобально');
        }
        const guild = validDiscordId(guildId) ? client.guilds.cache.get(guildId) : null;
        if (guild) {
            const existing = await guild.commands.fetch();
            if (!existing.some(command => command.name === commandData.name)) {
                await guild.commands.create(commandData);
                console.log('✅ Discord-команда /stream-audio зарегистрирована на сервере');
            }
            return;
        }

        const existing = await client.application.commands.fetch();
        if (!existing.some(command => command.name === commandData.name)) {
            await client.application.commands.create(commandData);
            console.log('✅ Discord-команда /stream-audio зарегистрирована (глобально)');
        }
    } catch (err) {
        console.warn('Не удалось проверить регистрацию /stream-audio:', err.message);
    }
}

function attachClientHandlers(client) {
    client.on(Events.ClientReady, async () => {
        console.log(`✅ Discord бот подключен как ${client.user.tag}`);
        await ensureStreamAudioCommand(client);
        const channel = await resolveNotificationChannel(client);
        if (channel) {
            console.log(`✅ Канал Discord настроен: #${channel.name}`);
        } else {
            console.error('❌ Не удалось найти Discord канал с ID:', process.env.DISCORD_CHANNEL_ID);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'stream-audio') return;
        try {
            await handleStreamAudioCommand(interaction);
        } catch (err) {
            console.error('Ошибка обработки /stream-audio:', err);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('Ошибка выполнения команды.');
                } else {
                    await interaction.reply({ content: 'Ошибка выполнения команды.', flags: MessageFlags.Ephemeral });
                }
            } catch {
                // окно ответа уже закрыто
            }
        }
    });

    client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
        console.warn(`⚠️ Discord шард ${shardId} отключился (code=${closeEvent?.code}), ждём восстановления...`);
        // discord.js сам пытается resume; health check подхватит, если не выйдет
    });

    client.on(Events.Error, err => {
        console.error('❌ Ошибка Discord бота:', err.message || err);
    });

    client.on(Events.ShardError, (err, shardId) => {
        console.error(`⚠️ Shard ${shardId} error:`, err.message);
    });

    client.on(Events.ShardReconnecting, shardId => {
        console.log(`⏳ Discord шард ${shardId} переподключается...`);
    });

    client.on(Events.Warn, info => {
        console.warn('⚠️ Discord warning:', info);
    });
}

async function connectDiscord() {
    if (!discordConfigured()) {
        console.log('⚠️ Discord интеграция не настроена (отсутствуют DISCORD_TOKEN или DISCORD_CHANNEL_ID)');
        return;
    }
    if (connecting) return;
    connecting = true;

    try {
        for (let attempt = 1; attempt <= DISCORD_MAX_ATTEMPTS; attempt += 1) {
            try {
                if (discordClient) {
                    try {
                        discordClient.destroy();
                    } catch (destroyErr) {
                        console.warn('⚠️ Не удалось завершить прежний Discord-клиент:', destroyErr.message);
                    }
                    discordClient = null;
                    notificationChannel = null;
                }

                discordClient = buildDiscordClient();
                attachClientHandlers(discordClient);

                await discordClient.login(process.env.DISCORD_TOKEN);

                if (!discordClient.isReady()) {
                    await new Promise(resolve => discordClient.once(Events.ClientReady, resolve));
                }

                return;
            } catch (err) {
                const isTimeout = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up|getaddrinfo/i.test(err.message || '');
                console.error(`❌ Попытка подключения к Discord ${attempt}/${DISCORD_MAX_ATTEMPTS} не удалась:`, err.message);

                if (attempt >= DISCORD_MAX_ATTEMPTS) {
                    console.error('❌ Discord подключение не удалось после всех попыток — health check повторит позже');
                    return;
                }

                await delay(isTimeout ? DISCORD_RETRY_DELAY_MS : Math.min(DISCORD_RETRY_DELAY_MS * 2, 15000));
            }
        }
    } finally {
        connecting = false;
        scheduleHealthCheck();
    }
}

async function sendStreamNotification(streamInfo) {
    if (!discordClient || !discordClient.isReady()) {
        console.warn('⚠️ Discord не подключен, уведомление о стриме не отправлено');
        return;
    }

    if (!notificationChannel) {
        // канал мог потеряться после переподключения — пробуем снова
        await resolveNotificationChannel(discordClient);
    }
    if (!notificationChannel) {
        console.warn('⚠️ Discord канал не готов для отправки уведомлений');
        return;
    }

    try {
        const roleMention = process.env.DISCORD_ROLE_ID ? `<@&${process.env.DISCORD_ROLE_ID}>` : '';
        const embed = {
            color: 0xFF0000,
            title: '🔴 СТРИМ НАЧАЛСЯ!',
            description: `**${streamInfo.userName}** начал трансляцию на Twitch!`,
            fields: [
                {
                    name: 'Название',
                    value: streamInfo.title || 'Без названия',
                    inline: false
                },
                {
                    name: 'Категория',
                    value: streamInfo.gameName || 'Неизвестно',
                    inline: true
                }
            ],
            thumbnail: {
                url: streamInfo.thumbnailUrl || ''
            },
            footer: {
                text: 'UBC Bot'
            },
            timestamp: new Date().toISOString()
        };

        const actionRow = {
            type: 1,
            components: [
                {
                    type: 2,
                    label: 'Смотреть на Twitch',
                    style: 5,
                    url: `https://twitch.tv/${process.env.CHANNEL_NAME}`
                }
            ]
        };

        await notificationChannel.send({
            content: roleMention || undefined,
            embeds: [embed],
            components: [actionRow],
            allowedMentions: roleMention ? { roles: [process.env.DISCORD_ROLE_ID] } : { parse: [] }
        });

        console.log('✅ Discord уведомление отправлено');
    } catch (err) {
        console.error('❌ Ошибка отправки Discord уведомления:', err.message);
    }
}

module.exports = {
    connectDiscord,
    sendStreamNotification,
    getDiscordClient: () => discordClient,
    getNotificationChannel: () => notificationChannel
};
