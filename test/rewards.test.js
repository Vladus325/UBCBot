const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebSocketServer } = require('ws');

const TEST_PORT = 4600 + Math.floor(Math.random() * 200);
process.env.EVENTSUB_WS_URL = `ws://127.0.0.1:${TEST_PORT}`;
process.env.BROADCASTER_ID = '12345';
process.env.CLIENT_ID_MY = 'test-client-id';
process.env.TWITCH_TOKEN_MY = 'test-token';
delete process.env.TWITCH_REFRESH_TOKEN_MY;

const rewards = require('../src/bot/rewards');

function envelope(messageType, extra = {}, metadataExtra = {}) {
    return JSON.stringify({
        metadata: {
            message_id: 'x',
            message_type: messageType,
            message_timestamp: new Date().toISOString(),
            ...metadataExtra
        },
        payload: extra
    });
}

function redemptionEvent(overrides = {}) {
    return {
        id: 'redemption-1',
        user_id: '42',
        user_login: 'viewer',
        user_name: 'Viewer',
        user_input: 'never gonna give you up',
        reward: { id: 'reward-1', title: 'Заказ музыки', cost: 125 },
        ...overrides
    };
}

test('EventSub-клиент: welcome, notification, ping/pong, обработчик редемпшена', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    const received = [];
    let clientSocket = null;
    let resolveConnected;
    const connectedPromise = new Promise(resolve => { resolveConnected = resolve; });

    wss.on('connection', (socket) => {
        clientSocket = socket;
        socket.on('message', raw => received.push(JSON.parse(raw.toString())));
        socket.send(envelope('session_welcome', { session: { id: 'sess-test-123' } }));
        resolveConnected();
    });

    await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

    const handlerCalls = [];
    rewards.setRedemptionHandler(async (event) => {
        handlerCalls.push(event);
        return true;
    });

    try {
        rewards.startEventSub();
        await connectedPromise;

        // уведомление о редемпшене должно доехать до обработчика целиком
        clientSocket.send(envelope(
            'notification',
            {
                subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
                event: redemptionEvent()
            },
            { subscription_type: 'channel.channel_points_custom_reward_redemption.add', subscription_version: '1' }
        ));

        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(handlerCalls.length, 1);
        assert.equal(handlerCalls[0].rewardId, 'reward-1');
        assert.equal(handlerCalls[0].redemptionId, 'redemption-1');
        assert.equal(handlerCalls[0].userId, '42');
        assert.equal(handlerCalls[0].login, 'viewer');
        assert.equal(handlerCalls[0].displayName, 'Viewer');
        assert.equal(handlerCalls[0].input, 'never gonna give you up');

        // на ping клиент должен ответить pong
        const pongsBefore = received.filter(m => m.type === 'pong').length;
        clientSocket.send(envelope('ping'));
        await new Promise(resolve => setTimeout(resolve, 100));
        const pongsAfter = received.filter(m => m.type === 'pong').length;
        assert.equal(pongsAfter, pongsBefore + 1);

        // мусорные сообщения не должны ронять клиент
        clientSocket.send('не-json{{{');
        clientSocket.send(envelope('session_keepalive'));
        await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
        rewards.stopEventSub();
        await new Promise(resolve => {
            wss.close(() => server.close(resolve));
        });
    }
});
