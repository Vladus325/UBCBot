const fs = require('fs');
const { refreshTokenPair } = require('./tokens');

function tokenKeysForClient(clientId) {
    if (clientId === process.env.CLIENT_ID_MY) {
        return { refreshKey: 'TWITCH_REFRESH_TOKEN_MY', tokenKey: 'TWITCH_TOKEN_MY' };
    }
    return { refreshKey: 'TWITCH_REFRESH_TOKEN', tokenKey: 'TWITCH_TOKEN' };
}

// Единая обёртка над Helix API: при 401 обновляет токен и повторяет запрос.
// Разрешены только официальные хосты Twitch — URL строится из литералов
// и ID из .env оператора, но ограничение хоста отсекает любые вариации.
const ALLOWED_API_HOSTS = new Set(['api.twitch.tv', 'id.twitch.tv']);

function assertAllowedApiUrl(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(target.hostname)) {
        throw new Error(`Недопустимый адрес Twitch API: ${target.hostname}`);
    }
}

async function makeApiCall(url, options, clientId) {
    assertAllowedApiUrl(url);
    let response = await fetch(url, options);

    if (response.status === 401) {
        const { refreshKey, tokenKey } = tokenKeysForClient(clientId);
        await refreshTokenPair(refreshKey, tokenKey);
        options.headers = {
            ...options.headers,
            Authorization: `Bearer ${process.env[tokenKey]}`
        };
        response = await fetch(url, options);
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Twitch API error: ${text}`);
    }

    return response;
}

function helixHeaders(accessToken, clientId, extra = {}) {
    return {
        'Client-ID': clientId,
        'Authorization': `Bearer ${accessToken}`,
        ...extra
    };
}

async function timeoutUser({
    broadcasterId,
    moderatorId,
    userId,
    duration,
    accessToken,
    clientId
}) {
    const url = `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`;
    const body = JSON.stringify({
        data: {
            user_id: userId,
            duration: duration,
            reason: 'Критическая неудача 😈'
        }
    });

    await makeApiCall(url, {
        method: 'POST',
        headers: helixHeaders(accessToken, clientId, { 'Content-Type': 'application/json' }),
        body
    }, clientId);
}

async function createReward({
    broadcasterId,
    title,
    cost,
    prompt,
    isUserInputRequired,
    image,
    accessToken,
    clientId
}) {
    const url = `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`;
    const response = await makeApiCall(url, {
        method: 'POST',
        headers: helixHeaders(accessToken, clientId, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            title,
            cost,
            prompt,
            is_user_input_required: isUserInputRequired,
            image: image || undefined
        })
    }, clientId);
    const data = await response.json();
    return data.data[0];
}

async function toggleReward({
    broadcasterId,
    rewardId,
    enabled,
    accessToken,
    clientId
}) {
    const url = `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`;
    await makeApiCall(url, {
        method: 'PATCH',
        headers: helixHeaders(accessToken, clientId, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ is_enabled: enabled })
    }, clientId);
}

async function deleteReward({
    broadcasterId,
    rewardId,
    accessToken,
    clientId
}) {
    const url = `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`;
    await makeApiCall(url, {
        method: 'DELETE',
        headers: helixHeaders(accessToken, clientId)
    }, clientId);
}

async function backupRewards({
    broadcasterId,
    accessToken,
    clientId
}) {
    console.log('🚀 BACKUP REWARDS START');

    const url = `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`;
    const response = await makeApiCall(url, {
        headers: helixHeaders(accessToken, clientId)
    }, clientId);

    const json = await response.json();
    const rewards = json.data;

    if (!Array.isArray(rewards)) {
        throw new Error('Не удалось получить награды');
    }

    console.log(`📥 Найдено наград: ${rewards.length}`);

    fs.writeFileSync('./rewards_backup.json', JSON.stringify(rewards, null, 2));
    console.log('💾 Backup сохранён');
}

async function restoreRewards({
    broadcasterId,
    accessToken,
    clientId
}) {
    console.log('🚀 RESTORE START');

    const rewards = JSON.parse(
        fs.readFileSync('./rewards_backup.json', 'utf-8')
    );

    const mapping = [];

    for (const r of rewards) {
        try {
            const newReward = await createReward({
                broadcasterId,
                title: r.title,
                cost: r.cost,
                prompt: r.prompt,
                isUserInputRequired: r.is_user_input_required,
                accessToken,
                clientId
            });

            console.log(`✅ Создана: ${r.title}`);

            mapping.push({
                oldId: r.id,
                newId: newReward.id,
                title: r.title
            });
        } catch (e) {
            console.error(`❌ Ошибка: ${r.title}`, e);
        }
    }

    fs.writeFileSync('./rewardMap.json', JSON.stringify(mapping, null, 2));

    console.log('💾 rewardMap.json сохранён');
    console.log('🔥 RESTORE DONE');
}

async function getRedemptions({
    broadcasterId,
    rewardId,
    userId,
    status = 'UNFULFILLED',
    accessToken,
    clientId
}) {
    const url = new URL('https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions');
    url.searchParams.append('broadcaster_id', broadcasterId);
    url.searchParams.append('reward_id', rewardId);
    url.searchParams.append('status', status);
    if (userId) {
        url.searchParams.append('user_id', userId);
    }

    const response = await makeApiCall(url.toString(), {
        method: 'GET',
        headers: helixHeaders(accessToken, clientId)
    }, clientId);

    const data = await response.json();
    return data.data || [];
}

async function patchRedemptionStatus({
    broadcasterId,
    rewardId,
    redemptionId,
    status,
    accessToken,
    clientId
}) {
    const url = `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${broadcasterId}&reward_id=${rewardId}&id=${redemptionId}`;
    await makeApiCall(url, {
        method: 'PATCH',
        headers: helixHeaders(accessToken, clientId, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status })
    }, clientId);
}

async function cancelRedemption({
    broadcasterId,
    rewardId,
    redemptionId,
    userId,
    accessToken,
    clientId
}) {
    let redemptionToCancel = redemptionId;

    if (!redemptionToCancel) {
        const list = await getRedemptions({ broadcasterId, rewardId, userId, accessToken, clientId });
        if (list.length === 0) {
            throw new Error('No UNFULFILLED redemption found to cancel');
        }
        redemptionToCancel = list[0].id;
    }

    const attempts = 3;
    let lastError;

    for (let i = 0; i < attempts; i++) {
        try {
            await patchRedemptionStatus({
                broadcasterId,
                rewardId,
                redemptionId: redemptionToCancel,
                status: 'CANCELED',
                accessToken,
                clientId
            });
            return;
        } catch (err) {
            lastError = err;

            // 404 может означать, что запрос уже не UNFULFILLED или id невалиден
            if (/"status":\s*404|Not Found/i.test(err.message || '')) {
                // попытаемся найти другой UNFULFILLED редемпшн для этого пользователя
                try {
                    const list = await getRedemptions({ broadcasterId, rewardId, userId, accessToken, clientId });
                    if (list.length > 0) {
                        redemptionToCancel = list[0].id;
                        continue; // повторим попытку с новым id
                    }
                } catch (nestedErr) {
                    lastError = nestedErr;
                }
                break; // ничего не найдено, не retry
            }

            if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(err.message || '')) {
                await new Promise(r => setTimeout(r, 500 * (i + 1)));
                continue;
            }
            throw err;
        }
    }

    throw lastError;
}

module.exports = {
    makeApiCall,
    timeoutUser,
    createReward,
    toggleReward,
    deleteReward,
    backupRewards,
    restoreRewards,
    cancelRedemption,
    patchRedemptionStatus
};
