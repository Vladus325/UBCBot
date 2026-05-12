const WebSocket = require('ws');
const TWITCH_PUBSUB_URL = 'wss://pubsub-edge.twitch.tv';

const { playRewardMedia } = require('./obsHook');

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

function startPubSub() {
    const ws = new WebSocket(TWITCH_PUBSUB_URL);
    let pingTimeout;
    let pingInterval;
    let isConnected = false;

    ws.on('open', () => {
        console.log('📡 PubSub подключен');
        reconnectAttempts = 0; // Сбрасываем счетчик при успешном подключении
        isConnected = false;

        // Устанавливаем таймер на 5 минут (более агрессивный таймаут)
        pingTimeout = setTimeout(() => {
            console.log('❌ Нет PING от сервера, переподключение... (таймаут истек)');
            ws.close();
        }, 5 * 60 * 1000); // 5 минут

        // Отправляем PING каждые 4 минуты, чтобы поддерживать соединение
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'PING' }));
                console.log('📤 Отправляем PING серверу');
            }
        }, 4 * 60 * 1000); // 4 минуты

        const message = {
            type: 'LISTEN',
            data: {
                topics: [`channel-points-channel-v1.${process.env.BROADCASTER_ID}`],
                auth_token: process.env.TWITCH_TOKEN_MY
            }
        };

        console.log('📨 Отправляем LISTEN для канала:', process.env.BROADCASTER_ID);
        ws.send(JSON.stringify(message));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('📥 Получено сообщение:', msg.type);

        if (msg.type === 'PING') {
            console.log('🏓 Получен PING от сервера');
            if (!isConnected) {
                console.log('✅ PubSub активен, получены PINGs');
                isConnected = true;
            }
            // Сбрасываем таймер при получении PING
            clearTimeout(pingTimeout);
            pingTimeout = setTimeout(() => {
                console.log('❌ Нет PING от сервера, переподключение... (таймаут истек)');
                ws.close();
            }, 5 * 60 * 1000);
            ws.send(JSON.stringify({ type: 'PONG' }));
            return;
        }

        if (msg.type === 'PONG') {
            console.log('🏓 Получен PONG от сервера');
            // Сбрасываем таймер при получении PONG (в ответ на наш PING)
            clearTimeout(pingTimeout);
            pingTimeout = setTimeout(() => {
                console.log('❌ Нет активности от сервера, переподключение... (таймаут истек)');
                ws.close();
            }, 5 * 60 * 1000);
            return;
        }

        if (msg.type === 'RESPONSE') {
            if (msg.error) {
                console.error('❌ Ошибка PubSub:', msg.error);
                ws.close(); // Закрываем соединение для перезапуска
            } else {
                console.log('✅ Успешно подписались на события');
            }
            return;
        }

        if (msg.type === 'MESSAGE') {
            const messageData = JSON.parse(msg.data.message);

            if (messageData.type === 'reward-redeemed') {
                handleReward(messageData.data.redemption);
            }
        }
    });

    ws.on('close', () => {
        console.log('❌ PubSub отключен, переподключение...');
        clearTimeout(pingTimeout);
        clearInterval(pingInterval);
        
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(30000, 5000 * reconnectAttempts); // Экспоненциальная задержка, макс 30 сек
            console.log(`⏳ Много попыток переподключения (${reconnectAttempts}), ждем ${delay}ms...`);
            setTimeout(startPubSub, delay);
        } else {
            setTimeout(startPubSub, 5000);
        }
    });

    ws.on('error', (err) => {
        console.error('❌ PubSub ошибка:', err.message || err);
        clearTimeout(pingTimeout);
        clearInterval(pingInterval);
    });
}

function handleReward(redemption) {
    const rewardTitle = redemption.reward.title;
    const user = redemption.user.display_name;
    const input = redemption.user_input || '';

    console.log('🎁 Награда:', rewardTitle);
    console.log('👤 Пользователь:', user);
    console.log('💬 Ввод:', input);

    const allowedTagPattern = /\((?:GS|S|V\+)\)/;
    if (!allowedTagPattern.test(rewardTitle)) return;

    playRewardMedia(rewardTitle).catch(err => {
        console.error('Ошибка при воспроизведении награды:', err);
    });

}

module.exports = { startPubSub };