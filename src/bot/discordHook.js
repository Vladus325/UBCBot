const { Client, GatewayIntentBits } = require('discord.js');

let discordClient = null;
let notificationChannel = null;

const DISCORD_MAX_ATTEMPTS = Number(process.env.DISCORD_RETRY_ATTEMPTS || 5);
const DISCORD_RETRY_DELAY_MS = Number(process.env.DISCORD_RETRY_DELAY_MS || 5000);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildDiscordClient() {
    return new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
        rest: {
            timeout: 30000,
            retries: 2,
            version: 10
        }
    });
}

async function connectDiscord() {
    if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CHANNEL_ID) {
        console.log('⚠️ Discord интеграция не настроена (отсутствуют DISCORD_TOKEN или DISCORD_CHANNEL_ID)');
        return;
    }

    for (let attempt = 1; attempt <= DISCORD_MAX_ATTEMPTS; attempt += 1) {
        try {
            if (discordClient) {
                try {
                    discordClient.destroy();
                } catch (destroyErr) {
                    console.warn('⚠️ Не удалось завершить прежний Discord-клиент:', destroyErr.message);
                }
            }

            discordClient = buildDiscordClient();

            discordClient.on('ready', async () => {
                console.log(`✅ Discord бот подключен как ${discordClient.user.tag}`);

                let channel = discordClient.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
                if (!channel) {
                    try {
                        channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
                    } catch (fetchErr) {
                        console.error('❌ Ошибка при fetch канала:', fetchErr.message);
                    }
                }

                if (channel && channel.isTextBased()) {
                    notificationChannel = channel;
                    console.log(`✅ Канал Discord настроен: #${channel.name}`);
                } else {
                    console.error('❌ Не удалось найти Discord канал с ID:', process.env.DISCORD_CHANNEL_ID);
                }
            });

            discordClient.on('error', err => {
                console.error('❌ Ошибка Discord бота:', err);
            });

            discordClient.on('shardError', (err, shardId) => {
                console.error(`⚠️ Shard ${shardId} error:`, err.message);
            });

            discordClient.on('warn', info => {
                console.warn('⚠️ Discord warning:', info);
            });

            await discordClient.login(process.env.DISCORD_TOKEN);

            if (!discordClient.readyAt) {
                await new Promise(resolve => discordClient.once('ready', resolve));
            }

            return;
        } catch (err) {
            const isTimeout = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(err.message || '');
            console.error(`❌ Попытка подключения к Discord ${attempt}/${DISCORD_MAX_ATTEMPTS} не удалась:`, err.message);

            if (attempt >= DISCORD_MAX_ATTEMPTS) {
                console.error('❌ Discord подключение не удалось после всех попыток');
                return;
            }

            if (isTimeout) {
                console.log(`⏳ Повторная попытка Discord через ${DISCORD_RETRY_DELAY_MS}мс...`);
                await delay(DISCORD_RETRY_DELAY_MS);
            } else {
                await delay(Math.min(DISCORD_RETRY_DELAY_MS * 2, 15000));
            }
        }
    }
}

async function sendStreamNotification(streamInfo) {
    if (!notificationChannel) {
        console.log('⚠️ Discord канал не готов для отправки уведомлений');
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
