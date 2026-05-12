const { refreshTokenPair } = require('./tokens');

async function handleTokenRefresh(clientId) {
    const refreshKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_REFRESH_TOKEN_MY' : 'TWITCH_REFRESH_TOKEN';
    const tokenKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_TOKEN_MY' : 'TWITCH_TOKEN';
    await refreshTokenPair(refreshKey, tokenKey);
    return process.env[tokenKey];
}

async function makeApiCall(url, options, clientId) {
    let response = await fetch(url, options);

    if (response.status === 401) {
        try {
            const newAccessToken = await handleTokenRefresh(clientId);
            options.headers.Authorization = `Bearer ${newAccessToken}`;
            response = await fetch(url, options);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`API error after token refresh: ${text}`);
            }
        } catch (refreshErr) {
            throw new Error(`Token refresh failed: ${refreshErr.message}`);
        }
    } else if (!response.ok) {
        const text = await response.text();
        throw new Error(`API error: ${text}`);
    }

    return response;
}

async function timeoutUser({
    broadcasterId,
    moderatorId,
    userId,
    duration,
    accessToken,
    clientId
}) {
    const response = await fetch(
        `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
        {
            method: 'POST',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    user_id: userId,
                    duration: duration,
                    reason: 'Критическая неудача 😈'
                }
            })
        }
    );

    if (!response.ok) {
        if (response.status === 401) {
            // Попытка обновить токен и повторить
            const refreshKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_REFRESH_TOKEN_MY' : 'TWITCH_REFRESH_TOKEN';
            const tokenKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_TOKEN_MY' : 'TWITCH_TOKEN';
            try {
                await refreshTokenPair(refreshKey, tokenKey);
                const newAccessToken = process.env[tokenKey];
                // Повторяем запрос с новым токеном
                const retryResponse = await fetch(
                    `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
                    {
                        method: 'POST',
                        headers: {
                            'Client-ID': clientId,
                            'Authorization': `Bearer ${newAccessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            data: {
                                user_id: userId,
                                duration: duration,
                                reason: 'Критическая неудача 😈'
                            }
                        })
                    }
                );
                if (!retryResponse.ok) {
                    const text = await retryResponse.text();
                    throw new Error(`Twitch API error after token refresh: ${text}`);
                }
                return; // Успех
            } catch (refreshErr) {
                throw new Error(`Token refresh failed: ${refreshErr.message}`);
            }
        } else {
            const text = await response.text();
            throw new Error(`Twitch API error: ${text}`);
        }
    }
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
    const options = {
        method: 'POST',
        headers: {
            'Client-ID': clientId,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            title,
            cost,
            prompt,
            is_user_input_required: isUserInputRequired,
            image: image || undefined
        })
    };

    const response = await makeApiCall(url, options, clientId);
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
    const response = await fetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`,
        {
            method: 'PATCH',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                is_enabled: enabled
            })
        }
    );

    if (!response.ok) {
        if (response.status === 401) {
            // Попытка обновить токен и повторить
            const refreshKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_REFRESH_TOKEN_MY' : 'TWITCH_REFRESH_TOKEN';
            const tokenKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_TOKEN_MY' : 'TWITCH_TOKEN';
            try {
                await refreshTokenPair(refreshKey, tokenKey);
                const newAccessToken = process.env[tokenKey];
                // Повторяем запрос с новым токеном
                const retryResponse = await fetch(
                    `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`,
                    {
                        method: 'PATCH',
                        headers: {
                            'Client-ID': clientId,
                            'Authorization': `Bearer ${newAccessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            is_enabled: enabled
                        })
                    }
                );
                if (!retryResponse.ok) {
                    const text = await retryResponse.text();
                    throw new Error(`Twitch API error after token refresh: ${text}`);
                }
                return;
            } catch (refreshErr) {
                throw new Error(`Token refresh failed: ${refreshErr.message}`);
            }
        } else {
            const text = await response.text();
            throw new Error(`Twitch API error: ${text}`);
        }
    }
}

async function deleteReward({
    broadcasterId,
    rewardId,
    accessToken,
    clientId
}) {
    const res = await fetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`,
        {
            method: 'DELETE',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`
            }
        }
    );

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Delete error: ${text}`);
    }
}

async function backupRewards({
    broadcasterId,
    accessToken,
    clientId
}) {
    console.log('🚀 BACKUP REWARDS START');

    // 1. Получаем награды
    const res = await fetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`,
        {
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`
            }
        }
    );

    const json = await res.json();
    const rewards = json.data;

    if (!Array.isArray(rewards)) {
        throw new Error('Не удалось получить награды');
    }

    console.log(`📥 Найдено наград: ${rewards.length}`);

    // 2. Сохраняем бэкап
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

    const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'Client-ID': clientId,
            'Authorization': `Bearer ${accessToken}`
        }
    });

    if (!res.ok) {
        if (res.status === 401) {
            // Попытка обновить токен и повторить
            const refreshKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_REFRESH_TOKEN_MY' : 'TWITCH_REFRESH_TOKEN';
            const tokenKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_TOKEN_MY' : 'TWITCH_TOKEN';
            try {
                await refreshTokenPair(refreshKey, tokenKey);
                const newAccessToken = process.env[tokenKey];
                // Повторяем запрос с новым токеном
                const retryRes = await fetch(url.toString(), {
                    method: 'GET',
                    headers: {
                        'Client-ID': clientId,
                        'Authorization': `Bearer ${newAccessToken}`
                    }
                });
                if (!retryRes.ok) {
                    const text = await retryRes.text();
                    throw new Error(`Get redemptions error after token refresh: ${text}`);
                }
                const data = await retryRes.json();
                return data.data || [];
            } catch (refreshErr) {
                throw new Error(`Token refresh failed: ${refreshErr.message}`);
            }
        } else {
            const text = await res.text();
            throw new Error(`Get redemptions error: ${text}`);
        }
    }

    const data = await res.json();
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
    const res = await fetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${broadcasterId}&reward_id=${rewardId}&id=${redemptionId}`,
        {
            method: 'PATCH',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status })
        }
    );

    if (!res.ok) {
        if (res.status === 401) {
            // Попытка обновить токен и повторить
            const refreshKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_REFRESH_TOKEN_MY' : 'TWITCH_REFRESH_TOKEN';
            const tokenKey = clientId === process.env.CLIENT_ID_MY ? 'TWITCH_TOKEN_MY' : 'TWITCH_TOKEN';
            try {
                await refreshTokenPair(refreshKey, tokenKey);
                const newAccessToken = process.env[tokenKey];
                // Повторяем запрос с новым токеном
                const retryRes = await fetch(
                    `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${broadcasterId}&reward_id=${rewardId}&id=${redemptionId}`,
                    {
                        method: 'PATCH',
                        headers: {
                            'Client-ID': clientId,
                            'Authorization': `Bearer ${newAccessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ status })
                    }
                );
                if (!retryRes.ok) {
                    const text = await retryRes.text();
                    throw new Error(`Cancel redemption error after token refresh: ${text}`);
                }
                return;
            } catch (refreshErr) {
                throw new Error(`Token refresh failed: ${refreshErr.message}`);
            }
        } else {
            const text = await res.text();
            throw new Error(`Cancel redemption error: ${text}`);
        }
    }
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
            if (err.message.includes('status:404') || err.message.includes('Not Found')) {
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

            if (err.type === 'system' || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED')) {
                const delay = 500 * (i + 1);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }

    throw lastError;
}

module.exports = { timeoutUser, createReward, toggleReward, deleteReward, backupRewards, restoreRewards, cancelRedemption };
