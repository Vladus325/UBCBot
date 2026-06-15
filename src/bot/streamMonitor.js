const fs = require('fs');
const path = require('path');
const { sendStreamNotification } = require('./discordHook');
const { refreshTokenPair } = require('./tokens');

const STREAM_STATE_FILE = path.resolve(__dirname, '..', '..', '.streamState.json');

function loadStreamState() {
    try {
        const raw = fs.readFileSync(STREAM_STATE_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        return { lastNotifiedStreamId: null };
    }
}

function saveStreamState(streamId) {
    try {
        fs.writeFileSync(STREAM_STATE_FILE, JSON.stringify({ lastNotifiedStreamId: streamId }, null, 2), 'utf-8');
    } catch (err) {
        console.error('❌ Не удалось сохранить состояние стрима:', err.message);
    }
}

const savedStreamState = loadStreamState();

let isStreamOnline = false;
let monitoringInterval = null;
const CHECK_INTERVAL = 60000; // Проверять каждые 60 секунд

async function getStreamStatus() {
    try {
        // Обновляем токен перед API запросом
        await refreshTokenPair('TWITCH_REFRESH_TOKEN_MY', 'TWITCH_TOKEN_MY');
        
        const response = await fetch(
            `https://api.twitch.tv/helix/streams?user_id=${process.env.BROADCASTER_ID}`,
            {
                headers: {
                    'Client-ID': process.env.CLIENT_ID_MY,
                    'Authorization': `Bearer ${process.env.TWITCH_TOKEN_MY}`
                }
            }
        );

        if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.data && data.data.length > 0 ? data.data[0] : null;
    } catch (err) {
        console.error('❌ Ошибка получения статуса стрима:', err.message);
        return null;
    }
}

async function getChannelInfo() {
    try {
        // Обновляем токен перед API запросом
        await refreshTokenPair('TWITCH_REFRESH_TOKEN_MY', 'TWITCH_TOKEN_MY');
        
        const response = await fetch(
            `https://api.twitch.tv/helix/channels?broadcaster_id=${process.env.BROADCASTER_ID}`,
            {
                headers: {
                    'Client-ID': process.env.CLIENT_ID_MY,
                    'Authorization': `Bearer ${process.env.TWITCH_TOKEN_MY}`
                }
            }
        );

        if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
        }

        const data = await response.json();
        return data.data && data.data.length > 0 ? data.data[0] : null;
    } catch (err) {
        console.error('❌ Ошибка получения информации о канале:', err.message);
        return null;
    }
}

async function checkStreamStatus() {
    const streamData = await getStreamStatus();
    const channelInfo = await getChannelInfo();
    
    if (streamData && !isStreamOnline) {
        const alreadyNotified = streamData.id && streamData.id === savedStreamState.lastNotifiedStreamId;
        if (alreadyNotified) {
            isStreamOnline = true;
            console.log('ℹ️ Стрим уже был отмечен ранее, повторное уведомление не отправляется');
            return;
        }

        // Стрим только что начался!
        isStreamOnline = true;
        console.log(`🔴 СТРИМ НАЧАЛСЯ: ${streamData.title}`);
        
        const notificationData = {
            userName: streamData.user_name,
            title: streamData.title,
            gameName: streamData.game_name,
            viewerCount: streamData.viewer_count,
            thumbnailUrl: streamData.thumbnail_url
        };
        
        // Отправляем уведомление в Discord
        await sendStreamNotification(notificationData);

        if (streamData.id) {
            saveStreamState(streamData.id);
            savedStreamState.lastNotifiedStreamId = streamData.id;
        }
    } else if (!streamData && isStreamOnline) {
        // Стрим завершился
        isStreamOnline = false;
        console.log('🟢 Стрим завершился');
    }
}

function startStreamMonitoring() {
    if (!process.env.TWITCH_TOKEN_MY || !process.env.BROADCASTER_ID) {
        console.log('⚠️ Мониторинг стрима не запущен (отсутствуют необходимые переменные)');
        return;
    }

    console.log('🔍 Запущен мониторинг статуса стрима (проверка каждые 60 сек)');
    
    // Первая проверка сразу
    checkStreamStatus().catch(err => {
        console.error('Ошибка при начальной проверке стрима:', err);
    });
    
    // Последующие проверки каждые 60 секунд
    monitoringInterval = setInterval(() => {
        checkStreamStatus().catch(err => {
            console.error('Ошибка при проверке стрима:', err);
        });
    }, CHECK_INTERVAL);
}

function stopStreamMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        console.log('⛔ Мониторинг стрима остановлен');
    }
}

module.exports = {
    startStreamMonitoring,
    stopStreamMonitoring,
    checkStreamStatus,
    getStreamStatus,
    getChannelInfo
};
