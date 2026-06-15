const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

let discordClient = null;
let notificationChannel = null;

async function connectDiscord() {
    if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CHANNEL_ID) {
        console.log('⚠️ Discord интеграция не настроена (отсутствуют DISCORD_TOKEN или DISCORD_CHANNEL_ID)');
        return;
    }

    try {
        discordClient = new Client({ 
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] 
        });

        discordClient.on('ready', async () => {
            console.log(`✅ Discord бот подключен как ${discordClient.user.tag}`);

            // Получаем канал для отправки уведомлений (сначала из кэша, иначе делаем fetch)
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

        await discordClient.login(process.env.DISCORD_TOKEN);

        // Убедимся, что клиент действительно готов перед возвратом
        if (!discordClient.readyAt) {
            await new Promise(resolve => discordClient.once('ready', resolve));
        }
    } catch (err) {
        console.error('❌ Ошибка подключения к Discord:', err.message);
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
