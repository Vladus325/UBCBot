const fetch = require('node-fetch');
const fs = require('fs');

async function saveEnvValue(key, value) {
    const envPath = './.env';
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
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

    fs.writeFileSync(envPath, newLines.join('\n'));
}

async function refreshTokenPair(refreshTokenKey, tokenKey) {
    const refreshToken = process.env[refreshTokenKey];
    if (!refreshToken) {
        console.warn(`${refreshTokenKey} не задан, обновление ${tokenKey} пропущено.`);
        return;
    }

    let url, headers, body;

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
        // twitchtokengenerator.com для основного токена
        url = `https://twitchtokengenerator.com/api/refresh/${refreshToken}`;
        headers = { 'Content-Type': 'application/json' };
        body = undefined;
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
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