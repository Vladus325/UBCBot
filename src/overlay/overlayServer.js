const express = require('express');
const musicQueue = require('../music/musicQueue');
const { refreshBrowserSource, waitForOBSConnection } = require('../bot/obsHook');

function startOverlayServer() {
    const app = express();
    const PORT = process.env.OVERLAY_PORT || 3000;

    // папка с overlay (где index.html)
    app.use(express.static(__dirname));

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

    // текущий трек
    app.get('/api/now', (req, res) => {
        res.json(musicQueue.getState());
    });

    // Пропустить трек (для автоматического перехода)
    app.post('/api/skip', (req, res) => {
        musicQueue.skip();
        res.json({ success: true });
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

    // 🔊 аудио поток
    app.get('/audio', (req, res) => {
        const currentTrack = musicQueue.current;
        const cacheFile = musicQueue.currentCacheFile;

        if (!currentTrack || !cacheFile) {
            return res.status(404).json({ error: 'No track playing' }).end();
        }

        const fs = require('fs');
        if (!fs.existsSync(cacheFile)) {
            return res.status(404).json({ error: 'File not found' }).end();
        }

        res.setHeader('Content-Type', 'audio/mp4'); // m4a is AAC in MPEG-4 container
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'close');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Length', fs.statSync(cacheFile).size);

        const stream = fs.createReadStream(cacheFile);
        stream.pipe(res);

        req.on('close', () => {
            stream.destroy();
        });

        res.on('error', () => {
            stream.destroy();
        });
    });

    const server = app.listen(PORT, async () => {
        console.log(`🎬 Overlay запущен: http://localhost:${PORT}`);
        // Ждем подключения к OBS и обновляем браузер-источник
        const obsConnected = await waitForOBSConnection(10000);
        if (obsConnected) {
            await refreshBrowserSource('МузыкаЗаказМой').catch(err => 
                console.error('Ошибка обновления браузера OBS:', err.message)
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
        musicQueue.isPlaying = false;
        if (musicQueue.ffmpegProcess) {
            try {
                musicQueue.ffmpegProcess.kill('SIGKILL');
            } catch (err) {
                console.error('Error killing ffmpeg:', err.message);
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

module.exports = { startOverlayServer };