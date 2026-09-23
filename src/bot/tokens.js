const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// Разрешённые конечные точки обновления токенов (allowlist)
const ALLOWED_TOKEN_HOSTS = new Set(['id.twitch.tv', 'twitchtokengenerator.com']);

function assertAllowedTokenUrl(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !ALLOWED_TOKEN_HOSTS.has(target.hostname)) {
        throw new Error(`Недопустимый адрес обновления токена: ${target.hostname}`);
    }
}

async function saveEnvValue(key, value) {
    if (!fs.existsSync(ENV_PATH)) return;

    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/);
    let updated = false;

    const newLines = lines.map(line => {
        if (line.startsWith(`${key}=`)) {
            updated = true;
            return `${key}=${value}`;
        }
        return line;
    });

    if (!updated) {
        newLines.push(`${key}=${value}`);
    }

    fs.writeFileSync(ENV_PATH, newLines.join('\n'));
}

async function refreshTokenPair(refreshTokenKey, tokenKey) {
    const refreshToken = process.env[refreshTokenKey];
    if (!refreshToken) {
        console.warn(`${refreshTokenKey} не задан, обновление ${tokenKey} пропущено.`);
        return;
    }

    let url, headers, method = 'POST', body;

    if (refreshTokenKey === 'TWITCH_REFRESH_TOKEN_MY') {
        // Официальный Twitch API для MY токена
        url = 'https://id.twitch.tv/oauth2/token';
        headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: process.env.CLIENT_ID_MY,
            client_secret: process.env.TWITCH_SECRET_MY
        });
    } else {
        // twitchtokengenerator.com для основного токена (API отвечает на GET,
        // на POST возвращает 405 Method Not Allowed)
        url = `https://twitchtokengenerator.com/api/refresh/${encodeURIComponent(refreshToken)}`;
        headers = { 'Content-Type': 'application/json' };
        method = 'GET';
        body = undefined;
    }

    try {
        assertAllowedTokenUrl(url);
        const res = await fetch(url, {
            method,
            headers,
            body
        });
        
        if (!res.ok) {
            const text = await res.text();
            const statusCode = res.status;

            throw new Error(`HTTP ${statusCode}: ${text.substring(0, 200)}`);
        }

        const data = await res.json();

        if (!data.access_token) {
            throw new Error('В ответе нет access_token');
        }

        process.env[tokenKey] = data.access_token;
        await saveEnvValue(tokenKey, data.access_token);

        if (data.refresh_token) {
            process.env[refreshTokenKey] = data.refresh_token;
            await saveEnvValue(refreshTokenKey, data.refresh_token);
        }

        console.log(`✅ ${tokenKey} успешно обновлён.`);
        return; // успех
    } catch (err) {
        console.error(`❌ Не удалось обновить ${tokenKey} после 1 попытки:`, err.message);
        console.error(`   Токен НЕ был изменён. Текущее значение сохранено.`);
    }
}

module.exports = { saveEnvValue, refreshTokenPair };