// Диагностика голосового подключения Discord:
// бот заходит в голосовой канал сервера DISCORD_GUILD_ID (имя или ID — первым
// аргументом, иначе первый найденный), логирует все переходы состояния,
// эндпоинт медиасервера и коды закрытия, затем выходит.
// Запуск: node scripts/diagnose-voice.js [канал]
// НЕ тест: намеренно ходит в живой Discord, поэтому не называется *.test.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Client, GatewayIntentBits, Events, ChannelType } = require('discord.js');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');

// Все запросы идут на фиксированный discord.com (REST-клиент discord.js);
// вход оператора только выбирает канал из уже полученного кэша.
// Snowflake-проверка отсекает мусор до похода в API.
function validDiscordId(id) {
    return /^\d{16,20}$/.test(String(id || ''));
}

// Аргумент командной строки: имя канала или его ID; ничего кроме сравнения
// с кэшем каналов не делает — ограничиваем длину и убираем управляющие символы
function sanitizeChannelArg(raw) {
    const value = String(raw || '').trim().slice(0, 100);
    if (/[\u0000-\u001f\u007f]/.test(value)) return '';
    return value;
}

async function main() {
    if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_GUILD_ID) {
        console.error('Нужны DISCORD_TOKEN и DISCORD_GUILD_ID в .env');
        process.exit(1);
    }
    if (!validDiscordId(process.env.DISCORD_GUILD_ID)) {
        console.error('DISCORD_GUILD_ID некорректен: ожидается числовой ID сервера');
        process.exit(1);
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });

    client.once(Events.ClientReady, async () => {
        console.log(`logged in as ${client.user.tag}`);
        try {
            const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
            await guild.channels.fetch();
            const wanted = sanitizeChannelArg(process.argv[2]);
            const voiceChannels = guild.channels.cache.filter(channel =>
                [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)
            );
            const voiceChannel = wanted
                ? voiceChannels.find(channel =>
                    (validDiscordId(wanted) && channel.id === wanted) || channel.name.includes(wanted))
                : voiceChannels.first();
            if (!voiceChannel) {
                console.log('Голосовой канал не найден. Доступны:');
                voiceChannels.forEach(channel => console.log(`  ${channel.id} | ${channel.name}`));
                process.exit(1);
            }
            console.log(`Пробую зайти в «${voiceChannel.name}»...`);

            const t0 = Date.now();
            // onVoiceServerUpdate/onVoiceStateUpdate — диспетчеры (принимают payload)
            const guildAdapter = guild.voiceAdapterCreator;
            const wrappedAdapter = (methods) => guildAdapter({
                ...methods,
                onVoiceServerUpdate: (data) => {
                    console.log(`  [gateway] VOICE_SERVER_UPDATE endpoint=${data.endpoint}`);
                    methods.onVoiceServerUpdate(data);
                },
                onVoiceStateUpdate: (data) => {
                    console.log(`  [gateway] VOICE_STATE_UPDATE channel=${data.channel_id} session=${data.session_id ? 'ok' : 'none'}`);
                    methods.onVoiceStateUpdate(data);
                }
            });

            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: wrappedAdapter,
                selfDeaf: true,
                debug: true
            });

            connection.on('debug', message => {
                console.log(`  +${String(Date.now() - t0).padStart(5)}мс  [debug] ${message.slice(0, 400)}`);
            });
            connection.on('stateChange', (oldState, newState) => {
                const extra = newState.status === 'disconnected'
                    ? ` (reason=${newState.reason} closeCode=${newState.closeCode ?? '—'})`
                    : '';
                console.log(`  +${String(Date.now() - t0).padStart(5)}мс  ${oldState.status} -> ${newState.status}${extra}`);
            });
            connection.on('error', err => {
                console.log(`  +${String(Date.now() - t0).padStart(5)}мс  CONNECTION ERROR: ${err.message}`);
            });

            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 30000);
                console.log(`ГОТОВО: голосовое соединение Ready за ${Date.now() - t0}мс — путь работает`);
            } catch (err) {
                console.log(`ПРОВАЛ за ${Date.now() - t0}мс: ${err.message}`);
                console.log('Финальное состояние:', connection.state.status);
            }

            connection.destroy();
            await new Promise(resolve => setTimeout(resolve, 1000));
            process.exit(0);
        } catch (err) {
            console.error('Ошибка диагностики:', err.message);
            process.exit(1);
        }
    });

    client.on('error', err => console.error('client error:', err.message));
    await client.login(process.env.DISCORD_TOKEN);
}

main();
