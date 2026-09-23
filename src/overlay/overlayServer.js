const express = require('express');
const fs = require('fs');
const path = require('path');
const musicQueue = require('../music/musicQueue');
const { refreshBrowserSource, waitForOBSConnection } = require('../bot/obsHook');
const { toggleReward } = require('../bot/twitchApi');

const SR_REWARD_IDS = [
    '5c8adc76-dc97-4b11-a355-ae24cf79912c',
    '6e53c204-ac7d-46bb-89d6-ce323531a63c',
    'b6adc235-77fd-456a-b6bd-a246562d9a9e'
];

const VR_REWARD_IDS = [
    '9c5f80ee-2074-4b25-8c66-89178a13ecef',
    '8909121d-c2c3-427f-95f6-feaf2f2fa92b',
    'a64afe27-756b-48c4-bdbd-17075dbb6828',
    'e8ebb4b5-8d7a-4e20-aff3-923213d6e616'
];

let wheelSpinBroadcaster = null;
const wheelSettingsPath = path.join(__dirname, '..', 'config', 'wheel_settings.json');
let wheelSettings = {
    duration: 8,
    image: '',
    music: ''
};

function getWheelSettings() {
    return { ...wheelSettings };
}
try {
    if (fs.existsSync(wheelSettingsPath)) {
        wheelSettings = { ...wheelSettings, ...JSON.parse(fs.readFileSync(wheelSettingsPath, 'utf8')) };
    }
} catch (err) {
    console.warn('⚠️ Не удалось загрузить настройки колеса:', err.message);
}
function readWheelEntries() {
    const configPath = path.join(__dirname, '..', 'config', 'wheel_config.txt');
    return fs.readFileSync(configPath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const separatorIndex = line.lastIndexOf('|');
            const label = separatorIndex === -1 ? line : line.slice(0, separatorIndex).trim();
            const weight = separatorIndex === -1 ? 1 : Number(line.slice(separatorIndex + 1).trim());
            return { label, weight, index };
        })
        .filter(entry => entry.label && Number.isFinite(entry.weight) && entry.weight > 0);
}

function pickWeightedEntry(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    let point = Math.random() * total;
    return entries.find(entry => {
        point -= entry.weight;
        return point <= 0;
    }) || entries[entries.length - 1];
}

function normalizeEnabled(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['false', 'off', 'disable', '0', 'no'].includes(normalized)) return false;
        if (['true', 'on', 'enable', '1', 'yes'].includes(normalized)) return true;
        return Boolean(normalized);
    }
    return Boolean(value);
}

async function getRewardEnabledState(rewardId) {
    if (!rewardId || !process.env.BROADCASTER_ID || !process.env.CLIENT_ID_MY || !process.env.TWITCH_TOKEN_MY) {
        return null;
    }

    try {
        const response = await fetch(
            `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${process.env.BROADCASTER_ID}&id=${rewardId}`,
            {
                headers: {
                    'Client-ID': process.env.CLIENT_ID_MY,
                    'Authorization': `Bearer ${process.env.TWITCH_TOKEN_MY}`
                }
            }
        );

        if (!response.ok) {
            return null;
        }

        const payload = await response.json();
        return payload?.data?.[0]?.is_enabled ?? null;
    } catch (err) {
        if (process.env.DEBUG_TWITCH_API === '1') {
            console.error(`Ошибка чтения состояния награды ${rewardId}:`, err.message);
        }
        return null;
    }
}

async function getRewardModesState() {
    const [srEnabled, vrEnabled, wheelEnabled] = await Promise.all([
        Promise.all(SR_REWARD_IDS.map(getRewardEnabledState)).then(results => results.length ? results.every(Boolean) : null),
        Promise.all(VR_REWARD_IDS.map(getRewardEnabledState)).then(results => results.length ? results.every(Boolean) : null),
        process.env.WHEEL_REWARD_ID ? getRewardEnabledState(process.env.WHEEL_REWARD_ID) : null
    ]);

    return {
        srEnabled,
        vrEnabled,
        wheelEnabled
    };
}

async function setRewardGroupState(rewardIds, enabled) {
    const ids = (rewardIds || []).filter(Boolean);
    if (!ids.length) {
        return { success: false, enabled, error: 'Нечего переключать' };
    }

    // Каждую награду переключаем отдельно: одна ошибка (рейт-лимит Twitch и
    // т.п.) не должна оставлять группу в неизвестном состоянии молча
    let updated = 0;
    const errors = [];
    for (const rewardId of ids) {
        try {
            await toggleReward({
                broadcasterId: process.env.BROADCASTER_ID,
                rewardId,
                enabled,
                accessToken: process.env.TWITCH_TOKEN_MY,
                clientId: process.env.CLIENT_ID_MY
            });
            updated += 1;
        } catch (err) {
            errors.push(`${rewardId}: ${err.message}`);
        }
    }

    if (errors.length) {
        console.error(`Ошибка переключения наград (${errors.length}/${ids.length}):`, errors.join('; '));
    }

    return {
        success: errors.length === 0,
        enabled,
        updated,
        failed: errors.length,
        error: errors.length ? errors[0] : undefined
    };
}

function triggerWheelSpin(settings = {}) {
    if (!wheelSpinBroadcaster) {
        throw new Error('Overlay-сервер колеса ещё не запущен');
    }
    const entries = readWheelEntries();
    if (!entries.length) {
        throw new Error('Колесо не содержит корректных вариантов');
    }
    const selected = pickWeightedEntry(entries);
    const currentSettings = { ...wheelSettings, ...settings };
    wheelSpinBroadcaster({
        type: 'spin',
        index: selected.index,
        duration: Math.max(1, Math.min(60, Number(currentSettings.duration) || 8)),
        image: String(currentSettings.image || ''),
        music: String(currentSettings.music || '')
    });
    return selected;
}

function startOverlayServer() {
    const app = express();
    const PORT = process.env.OVERLAY_PORT || 3000;

    // папка с overlay (где index.html)
    app.use(express.json());
    app.use(express.static(__dirname));
    const wheelClients = [];

    function broadcastWheelSpin(payload) {
        const message = `data: ${JSON.stringify(payload)}\n\n`;
        wheelClients.forEach(client => {
            try {
                client.write(message);
            } catch (err) {
                console.error('Ошибка отправки события колеса:', err.message);
            }
        });
    }
    wheelSpinBroadcaster = broadcastWheelSpin;

    app.get('/obs', (req, res) => {
        res.sendFile(path.join(__dirname, 'obs-widget.html'));
    });

    app.get('/widget', (req, res) => {
        res.sendFile(path.join(__dirname, 'obs-widget.html'));
    });

    app.get('/wheel', (req, res) => {
        res.sendFile(path.join(__dirname, 'wheel.html'));
    });

    app.get('/wheel-widget', (req, res) => {
        res.sendFile(path.join(__dirname, 'wheel.html'));
    });

    app.get('/api/wheel/events', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.write(': connected\n\n');
        wheelClients.push(res);
        const pingInterval = setInterval(() => res.write(': ping\n\n'), 30000);

        req.on('close', () => {
            clearInterval(pingInterval);
            const index = wheelClients.indexOf(res);
            if (index >= 0) wheelClients.splice(index, 1);
        });
    });

    app.get('/api/modes', async (req, res) => {
        try {
            const state = await getRewardModesState();
            return res.json(state);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/mode/sr', async (req, res) => {
        try {
            const enabled = normalizeEnabled(req.body?.enabled ?? req.query?.enabled, false);
            const result = await setRewardGroupState(SR_REWARD_IDS, enabled);
            return res.json(result);
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/mode/vr', async (req, res) => {
        try {
            const enabled = normalizeEnabled(req.body?.enabled ?? req.query?.enabled, false);
            const result = await setRewardGroupState([...VR_REWARD_IDS, ...SR_REWARD_IDS], enabled);
            return res.json(result);
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/wheel/reward', async (req, res) => {
        try {
            const rewardId = process.env.WHEEL_REWARD_ID;
            if (!rewardId) {
                return res.status(400).json({ success: false, error: 'WHEEL_REWARD_ID не настроен' });
            }

            const enabled = normalizeEnabled(req.body?.enabled ?? req.query?.enabled, false);
            const result = await toggleReward({
                broadcasterId: process.env.BROADCASTER_ID,
                rewardId,
                enabled,
                accessToken: process.env.TWITCH_TOKEN_MY,
                clientId: process.env.CLIENT_ID_MY
            });

            return res.json({ success: true, enabled, result });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/wheel/spin', (req, res) => {
        const payload = req.body || {};
        const index = Number(payload.index);
        const duration = Math.max(1, Math.min(60, Number(payload.duration) || 8));

        if (Number.isInteger(index) && index >= 0) {
            broadcastWheelSpin({
                type: 'spin',
                index,
                duration,
                image: String(payload.image || ''),
                music: String(payload.music || '')
            });
            return res.json({ success: true, index, duration });
        }

        try {
            const selected = triggerWheelSpin({ duration, image: String(payload.image || ''), music: String(payload.music || '') });
            return res.json({ success: true, selected, duration });
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
    });

    app.get('/api/wheel', (req, res) => {
        try {
            const entries = readWheelEntries();

            if (!entries.length) {
                return res.status(500).json({ error: 'Колесо не содержит корректных вариантов' });
            }

            return res.json({ entries });
        } catch (err) {
            return res.status(500).json({ error: `Не удалось прочитать колесо: ${err.message}` });
        }
    });

    app.get('/api/wheel/settings', (req, res) => {
        res.json(getWheelSettings());
    });

    app.post('/api/wheel/settings', (req, res) => {
        const payload = req.body || {};
        wheelSettings = {
            duration: Math.max(1, Math.min(60, Number(payload.duration) || 8)),
            image: String(payload.image || '').trim(),
            music: String(payload.music || '').trim()
        };
                fs.writeFileSync(wheelSettingsPath, JSON.stringify(wheelSettings, null, 2), 'utf8');
        return res.json({ success: true, settings: getWheelSettings() });
    });

    app.get('/api/wheel-asset', (req, res) => {
        const assetPath = String(req.query.path || '').trim();
        const mediaTypes = {
            '.gif': 'image/gif',
            '.jpeg': 'image/jpeg',
            '.jpg': 'image/jpeg',
            '.mp3': 'audio/mpeg',
            '.ogg': 'audio/ogg',
            '.png': 'image/png',
            '.wav': 'audio/wav',
            '.webp': 'image/webp'
        };
        const contentType = mediaTypes[path.extname(assetPath).toLowerCase()];

        if (!assetPath || !contentType || !path.isAbsolute(assetPath)) {
            return res.status(400).json({ error: 'Укажите абсолютный путь к поддерживаемому медиафайлу' });
        }

        try {
            if (!fs.statSync(assetPath).isFile()) {
                return res.status(404).json({ error: 'Медиафайл не найден' });
            }
            res.type(contentType);
            res.setHeader('Cache-Control', 'no-cache');
            return res.sendFile(assetPath);
        } catch (err) {
            return res.status(404).json({ error: `Не удалось открыть медиафайл: ${err.message}` });
        }
    });

    // Список подписанных клиентов для SSE
    const clients = [];

    // Текущий трек для быстрых обновлений
    let lastTrackUpdate = null;

    // Слушаем события от musicQueue
    musicQueue.on('trackStart', (track) => {
        lastTrackUpdate = {
            type: 'trackStart',
            title: track.title,
            requestedBy: track.requestedBy,
            duration: track.duration
        };
        broadcastUpdate();
    });

    musicQueue.on('skip', () => {
        broadcastUpdate({ type: 'skip' });
    });

    musicQueue.on('pause', () => {
        broadcastUpdate({ type: 'pause' });
    });

    musicQueue.on('play', () => {
        broadcastUpdate({ type: 'play' });
    });

    musicQueue.on('stateChanged', (state) => {
        broadcastUpdate(state);
    });

    // текущий трек
    app.get('/api/now', (req, res) => {
        res.json(musicQueue.getPublicState());
    });

    app.get('/api/queue', (req, res) => {
        res.json(musicQueue.getQueueSnapshot());
    });

    app.post('/api/order', async (req, res) => {
        try {
            const payload = req.body || {};
            const query = String(payload.query || '').trim();
            const username = String(payload.username || 'UI').trim() || 'UI';
            const level = Number(payload.level) || 1;

            if (!query) {
                return res.status(400).json({ success: false, error: 'Введите ссылку или название трека' });
            }

            const track = await musicQueue.add(query, username, level, null, { allowLocal: true });
            return res.json({ success: true, track });
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
    });

    // Пропустить трек (ручной скип по кнопке/команде)
    app.post('/api/skip', (req, res) => {
        musicQueue.skip();
        res.json({ success: true });
    });

    // Автопереход: overlay сообщил, что звук закончился.
    // trackId защищает от двойного скипа при нескольких клиентах.
    app.post('/api/track-ended', (req, res) => {
        const trackId = String(req.body?.trackId || '').trim();
        const advanced = musicQueue.advanceEnded(trackId);
        res.json({ success: true, advanced });
    });

    // Пауза трека
    app.post('/api/pause', (req, res) => {
        const success = musicQueue.pause();
        res.json({ success });
    });

    // Возобновить трек
    app.post('/api/play', (req, res) => {
        const success = musicQueue.play();
        res.json({ success });
    });

    app.post('/api/clear-queue', async (req, res) => {
        try {
            const result = await musicQueue.clearQueue();
            return res.json({ success: true, ...result });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/sleep', async (req, res) => {
        try {
            const { path: playlistPath, enabled } = req.query;
            if (playlistPath) {
                const result = await musicQueue.setSleepPlaylist(playlistPath);
                return res.json({ success: true, ...result });
            }
            const success = musicQueue.setSleepMode(enabled !== 'false');
            return res.json({ success: true, enabled: success });
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
    });

    // SSE endpoint для быстрых обновлений
    app.get('/api/events', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Отправляем последнее обновление
        if (lastTrackUpdate) {
            res.write(`data: ${JSON.stringify(lastTrackUpdate)}\n\n`);
        }

        // Добавляем клиента в список
        clients.push(res);

        // Ping каждые 30 секунд чтобы soket не закрывался
        const pingInterval = setInterval(() => {
            res.write(`: ping\n\n`);
        }, 30000);

        req.on('close', () => {
            clearInterval(pingInterval);
            const index = clients.indexOf(res);
            if (index > -1) {
                clients.splice(index, 1);
            }
        });
    });

    // Функция для отправки обновления всем клиентам
    function broadcastUpdate(update) {
        const data = update || lastTrackUpdate || musicQueue.getState();
        clients.forEach(client => {
            try {
                client.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (err) {
                console.error('Error broadcasting update:', err.message);
            }
        });
    }

    // 🔊 аудио поток с поддержкой Range: клиент может сикаться
    // (ресинк после паузы/перезагрузки overlay)
    app.get('/audio', (req, res) => {
        const currentTrack = musicQueue.current;
        const cacheFile = musicQueue.currentCacheFile;

        if (!currentTrack || !cacheFile) {
            return res.status(404).json({ error: 'No track playing' }).end();
        }

        if (!fs.existsSync(cacheFile)) {
            return res.status(404).json({ error: 'File not found' }).end();
        }

        const fileSize = fs.statSync(cacheFile).size;
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Accept-Ranges', 'bytes');

        const rangeMatch = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
        if (rangeMatch) {
            const start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
            const requestedEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;
            const end = Math.min(requestedEnd, fileSize - 1);

            if (start >= fileSize || start < 0 || start > end) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).end();
            }

            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', end - start + 1);
            const stream = fs.createReadStream(cacheFile, { start, end });
            stream.pipe(res);
            req.on('close', () => stream.destroy());
            res.on('error', () => stream.destroy());
            return;
        }

        res.setHeader('Content-Length', fileSize);
        const stream = fs.createReadStream(cacheFile);
        stream.pipe(res);
        req.on('close', () => stream.destroy());
        res.on('error', () => stream.destroy());
    });

    const server = app.listen(PORT, async () => {
        console.log(`🎬 Overlay запущен: http://localhost:${PORT}`);
        // Ждем подключения к OBS и обновляем браузер-источник
        const obsConnected = await waitForOBSConnection(10000);
        if (obsConnected) {
            await refreshBrowserSource('МузыкаЗаказМой').catch(err => 
                console.error('Ошибка обновления браузера OBS:', err.message)
            );
            await refreshBrowserSource('Колесо выбора').catch(err =>
                console.error('Ошибка обновления браузера OBS для колеса:', err.message)
            );
        }
    });

    // Graceful shutdown
    function gracefulShutdown(_) {
        // Закрываем все SSE соединения
        clients.forEach(client => {
            try {
                client.end();
            } catch (err) {
                console.error('Error closing client:', err.message);
            }
        });
        clients.length = 0;

        // Останавливаем musicQueue
        musicQueue.shutdownRequested = true;
        if (musicQueue.watchdogTimer) {
            clearInterval(musicQueue.watchdogTimer);
        }
        for (const proc of musicQueue.downloadProcesses.values()) {
            try {
                proc.kill('SIGKILL');
            } catch (err) {
                console.error('Error killing download:', err.message);
            }
        }
        if (musicQueue.downloadProcess) {
            try {
                musicQueue.downloadProcess.kill('SIGKILL');
            } catch (err) {
                console.error('Error killing download:', err.message);
            }
        }

        server.close(() => {
            process.exit(0);
        });

        // Если сервер не закроется за 5 сек - силовой выход
        setTimeout(() => {
            process.exit(1);
        }, 5000);
    }

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    return server;
}

module.exports = { startOverlayServer, triggerWheelSpin, getWheelSettings };