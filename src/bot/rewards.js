const WebSocket = require('ws');
const { playRewardMedia } = require('./obsHook');
const { triggerWheelSpin } = require('../overlay/overlayServer');
const { patchRedemptionStatus, timeoutUser, makeApiCall } = require('./twitchApi');

// Twitch закрыл PubSub — используем EventSub WebSocket.
// Одна подписка channel.channel_points_custom_reward_redemption.add покрывает
// и музыкальные награды, и колесо, и OBS-медиа.
const EVENTSUB_WS_URL = process.env.EVENTSUB_WS_URL || 'wss://eventsub.wss.twitch.tv/ws';
const REDEMPTION_EVENT_TYPE = 'channel.channel_points_custom_reward_redemption.add';
const RESUBSCRIBE_DELAY_MS = 30000;
// Twitch шлёт keepalive по умолчанию раз в 10 минут — тишина дольше 11 минут значит, что соединение мертво
const LIVENESS_SILENCE_MS = 11 * 60 * 1000;

let ws = null;
let oldWs = null; // предыдущее соединение при reconnect-переносе
let sessionId = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let resubscribeTimer = null;
let livenessTimer = null;
let lastMessageAt = 0;
let stopping = false;

// Внешний обработчик редемпшенов (музыка). Возвращает true, если событие его.
let redemptionHandler = null;

function setRedemptionHandler(handler) {
    redemptionHandler = typeof handler === 'function' ? handler : null;
}

function eventSubConfigured() {
    return Boolean(process.env.BROADCASTER_ID && process.env.CLIENT_ID_MY && process.env.TWITCH_TOKEN_MY);
}

async function createRedemptionSubscription() {
    const url = 'https://api.twitch.tv/helix/eventsub/subscriptions';
    await makeApiCall(url, {
        method: 'POST',
        headers: {
            'Client-ID': process.env.CLIENT_ID_MY,
            'Authorization': `Bearer ${process.env.TWITCH_TOKEN_MY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: REDEMPTION_EVENT_TYPE,
            version: '1',
            condition: {
                broadcaster_user_id: process.env.BROADCASTER_ID
            },
            transport: {
                // проверено на живом API (2026-09): Twitch ждёт method, а не type
                method: 'websocket',
                session_id: sessionId
            }
        })
    }, process.env.CLIENT_ID_MY);
    console.log('✅ EventSub: подписка на награды создана');
}

// Подписка привязана к session_id; при сбое Helix повторяем, не рвя соединение
function scheduleResubscribe(delayMs = 1000) {
    if (stopping) return;
    clearTimeout(resubscribeTimer);
    resubscribeTimer = setTimeout(async () => {
        resubscribeTimer = null;
        if (!sessionId || stopping) return;
        try {
            await createRedemptionSubscription();
            reconnectAttempts = 0;
        } catch (err) {
            if (/"status":\s*409|already exists/i.test(err.message || '')) {
                console.log('ℹ️ EventSub: подписка уже существует');
                reconnectAttempts = 0;
                return;
            }
            console.error('❌ EventSub: не удалось создать подписку:', err.message);
            scheduleResubscribe(RESUBSCRIBE_DELAY_MS);
        }
    }, delayMs);
    if (typeof resubscribeTimer.unref === 'function') {
        resubscribeTimer.unref();
    }
}

async function handleRedemptionEvent(event) {
    const rewardId = event.reward.id;
    const rewardTitle = event.reward.title;
    const login = event.user_login || event.user_name;
    const displayName = event.user_name || login;
    const input = event.user_input || '';

    console.log('🎁 Награда:', rewardTitle);
    console.log('👤 Пользователь:', displayName);
    console.log('💬 Ввод:', input);

    if (redemptionHandler) {
        try {
            const handled = await redemptionHandler({
                rewardId,
                redemptionId: event.id,
                userId: event.user_id,
                login,
                displayName,
                input
            });
            if (handled) return;
        } catch (err) {
            console.error('Ошибка обработчика редемпшена:', err.message);
        }
    }

    if (process.env.WHEEL_REWARD_ID && rewardId === process.env.WHEEL_REWARD_ID) {
        try {
            const selected = triggerWheelSpin();
            console.log(`🎡 Колесо запущено для ${displayName}: ${selected.label}`);
            if (selected.label.trim().toLowerCase() === 'таймаут на 600с') {
                timeoutUser({
                    broadcasterId: process.env.BROADCASTER_ID,
                    moderatorId: process.env.MODERATOR_ID,
                    userId: event.user_id,
                    duration: 600,
                    accessToken: process.env.TWITCH_TOKEN_MY,
                    clientId: process.env.CLIENT_ID_MY
                }).then(() => {
                    console.log(`⏱️ ${displayName} получил таймаут на 600 секунд за выпадение сектора`);
                }).catch(err => {
                    console.error('Ошибка таймаута выпавшего сектора:', err.message);
                });
            }
            await fulfillReward(event);
        } catch (err) {
            console.error('Ошибка запуска колеса:', err.message);
        }
        return;
    }

    const allowedTagPattern = /\((?:GS|S|V\+)\)/;
    if (!allowedTagPattern.test(rewardTitle)) return;

    playRewardMedia(rewardTitle).catch(err => {
        console.error('Ошибка при воспроизведении награды:', err);
    });
}

async function fulfillReward(event) {
    if (!event.id || !event.reward.id) return;
    await patchRedemptionStatus({
        broadcasterId: process.env.BROADCASTER_ID,
        rewardId: event.reward.id,
        redemptionId: event.id,
        status: 'FULFILLED',
        accessToken: process.env.TWITCH_TOKEN_MY,
        clientId: process.env.CLIENT_ID_MY
    });
}

function safeSend(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(payload);
        } catch (err) {
            console.error('EventSub: ошибка отправки:', err.message);
        }
    }
}

function handleMessage(socket, raw) {
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch {
        return;
    }
    if (!msg || !msg.metadata) return;
    lastMessageAt = Date.now();

    switch (msg.metadata.message_type) {
        case 'session_welcome': {
            sessionId = msg.payload?.session?.id || null;
            console.log(`📡 EventSub подключен (session ${sessionId ? sessionId.slice(0, 8) + '…' : '?'})`);
            if (oldWs) {
                // подписки переносятся на новое соединение автоматически
                console.log('✅ EventSub: переподключение завершено');
                const stale = oldWs;
                oldWs = null;
                try { stale.close(1000, 'reconnected'); } catch { /* уже закрыт */ }
            } else {
                reconnectAttempts = 0;
                scheduleResubscribe(0);
            }
            break;
        }

        case 'notification': {
            if (msg.metadata.subscription_type === REDEMPTION_EVENT_TYPE && msg.payload?.event) {
                handleRedemptionEvent(msg.payload.event).catch(err => {
                    console.error('EventSub: ошибка обработки события:', err.message);
                });
            }
            break;
        }

        case 'ping': {
            // отвечать нужно в течение 10 секунд, иначе Twitch закроет соединение
            safeSend(socket, JSON.stringify({ type: 'pong' }));
            break;
        }

        case 'reconnect': {
            const reconnectUrl = msg.payload?.session?.reconnect_url;
            if (!reconnectUrl || oldWs || stopping) return;
            console.log('🔄 EventSub: сервер требует переподключение');
            oldWs = socket;
            connect(reconnectUrl);
            break;
        }

        case 'revocation': {
            console.warn('⚠️ EventSub: подписка отозвана:', msg.payload?.subscription?.type);
            break;
        }

        case 'session_keepalive':
            break;

        default:
            break;
    }
}

function scheduleReconnect() {
    if (stopping) return;
    reconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * reconnectAttempts);
    console.log(`⏳ EventSub переподключение через ${delay}мс (попытка ${reconnectAttempts})`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(), delay);
    if (typeof reconnectTimer.unref === 'function') {
        reconnectTimer.unref();
    }
}

function connect(url = EVENTSUB_WS_URL) {
    if (stopping) return;
    clearTimeout(reconnectTimer);

    const socket = new WebSocket(url);

    socket.on('message', raw => handleMessage(socket, raw));

    socket.on('error', err => {
        if (socket !== ws) return;
        console.error('❌ EventSub ошибка:', err.message || err);
    });

    socket.on('close', () => {
        if (socket !== ws) return; // старое соединение после reconnect-переноса
        if (ws === socket) {
            ws = null;
            sessionId = null;
        }
        console.log('❌ EventSub отключен');
        scheduleReconnect();
    });

    ws = socket;
    lastMessageAt = Date.now();
}

function checkLiveness() {
    if (!ws || stopping) return;
    if (lastMessageAt && Date.now() - lastMessageAt > LIVENESS_SILENCE_MS) {
        console.warn('⚠️ EventSub: слишком долгая тишина (нет keepalive), переподключаюсь');
        try {
            ws.terminate();
        } catch {
            // close-обработчик всё равно сработает
        }
    }
}

function startEventSub() {
    if (!eventSubConfigured()) {
        console.warn('⚠️ EventSub не запущен: нужны BROADCASTER_ID, CLIENT_ID_MY, TWITCH_TOKEN_MY');
        return;
    }

    console.log('🚀 EventSub WebSocket запуск...');
    connect();

    livenessTimer = setInterval(checkLiveness, 60000);
    if (typeof livenessTimer.unref === 'function') {
        livenessTimer.unref();
    }
}

function stopEventSub() {
    stopping = true;
    clearTimeout(reconnectTimer);
    clearTimeout(resubscribeTimer);
    clearInterval(livenessTimer);
    for (const socket of [ws, oldWs]) {
        if (socket) {
            try { socket.close(1000, 'shutdown'); } catch { /* уже закрыт */ }
        }
    }
    ws = null;
    oldWs = null;
    sessionId = null;
}

module.exports = {
    startEventSub,
    stopEventSub,
    setRedemptionHandler
};
