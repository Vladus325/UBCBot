const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { sendMediaPlayPause } = require('./aimpControl');
const { setSourceVisibility } = require('../bot/obsHook');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path || ffprobePath);

function probeFile(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
        });
    });
}

// Создаем папку для кэша если не существует
const CACHE_DIR = path.join(__dirname, 'audio_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const MAX_DURATIONS = { 1: 180, 2: 420, 3: 1800 };
const OBS_MUSIC_TICKER_SOURCE = 'Бегущая строка музыки';

class MusicQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.current = null;
        this.currentCacheFile = null;
        this.startedAt = null;
        this.cache = new Map();
        this.downloadProcess = null;
        this.ffmpegProcess = null;
        this.backgroundProcessId = null;
        this.cancelledProcessIds = new Set();
        this.isPlaying = false;
        this.aimpPausedForOrder = false;
        this.isPaused = false;
        this.pausedAt = 0;

        this._initIdleAimp();
    }

    _initIdleAimp() {
        // AIMP auto-start disabled - only works if AIMP is already running
    }

    async startAimpIfIdle() {
        if (this.current || this.queue.length > 0) {
            return;
        }

        // Только возобновляем если AIMP был на паузе, не запускаем автоматически
        if (this.aimpPausedForOrder) {
            const resumed = await sendMediaPlayPause();
            if (resumed) {
                this.aimpPausedForOrder = false;
            }
        }
    }

    async pauseAimpForOrder() {
        if (this.aimpPausedForOrder) {
            return;
        }

        const paused = await sendMediaPlayPause();
        if (paused) {
            this.aimpPausedForOrder = true;
        }
    }

    async showMusicTicker() {
        await setSourceVisibility(OBS_MUSIC_TICKER_SOURCE, true);
    }

    async hideMusicTicker() {
        await setSourceVisibility(OBS_MUSIC_TICKER_SOURCE, false);
    }

    async add(query, username, level, redemptionData = null) {
        query = cleanYouTubeUrl(query);

        // проверка кэша
        if (this.cache.has(query)) {
            const cached = { ...this.cache.get(query), requestedBy: username, redemptionData };
            this.queue.push(cached);
            await this.pauseAimpForOrder();
            this.hideMusicTicker().catch(err => console.error('OBS: не удалось скрыть бегущую строку:', err.message));

            // Только начинаем воспроизведение если ничего не играет
            try {
                if (!this.current) {
                    await this.playNext();
                }
            } catch (err) {
                throw new Error("Ошибка:", err);
            }
            return cached;
        }

        const info = await this.getInfo(query);

        if (info.duration > MAX_DURATIONS[level]) {
            throw new Error(`Трек слишком длинный (макс ${Math.floor(MAX_DURATIONS[level] / 60)} мин)`);
        }

        const track = {
            title: info.title,
            url: info.webpage_url,
            duration: info.duration || 0,
            requestedBy: username,
            level: level,
            redemptionData
        };

        this.cache.set(query, track);
        this.queue.push(track);
        await this.pauseAimpForOrder();
        this.hideMusicTicker().catch(err => console.error('OBS: не удалось скрыть бегущую строку:', err.message));

        try {
            // Только начинаем воспроизведение если ничего не играет
            if (!this.current) {
                await this.playNext();
            }
        } catch (err) {
            throw new Error("Ошибка:", err);
        }

        return track;
    }

    getInfo(query) {
        return new Promise((resolve, reject) => {
            // Check if query is a URL
            const isUrl = query.startsWith('http://') || query.startsWith('https://');
            const searchQuery = isUrl ? query : `ytsearch1:${query}`;

            const yt = spawn('yt-dlp', [
                '-j',
                '--no-playlist',
                '--js-runtime', 'node',
                searchQuery
            ]);

            let data = '';
            yt.stdout.on('data', chunk => data += chunk);

            yt.on('close', code => {
                if (code !== 0) return reject(new Error('yt-dlp failed'));
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch {
                    reject(new Error('Ошибка парсинга yt-dlp JSON'));
                }
            });

            yt.on('error', reject);
        });
    }

    async playNext() {
        console.log('Playing next track...');
        if (this.downloadProcess) {
            try {
                this.downloadProcess.kill('SIGKILL');
            } catch (err) {
                console.error('Error killing download:', err.message);
            }
            this.downloadProcess = null;
        }
        
        if (this.ffmpegProcess) {
            try {
                if (typeof this.ffmpegProcess.kill === 'function') {
                    this.ffmpegProcess.kill();
                }
            } catch (err) {
                console.error('Error killing ffmpeg:', err.message);
            }
            this.ffmpegProcess = null;
        }

        this.current = this.queue.shift() || null;

        if (!this.current) {
            await this.showMusicTicker();
            await this.startAimpIfIdle();
            return;
        }

        await this.hideMusicTicker();

        // Генерируем имя файла кэша
        const cacheFile = path.join(CACHE_DIR, this.getCacheFileName(this.current.url));
        console.log('Generated cache file name:', cacheFile); 
        
        // Проверяем, есть ли уже в кэше
        if (fs.existsSync(cacheFile)) {
            console.log('Found in cache:', cacheFile);
            try {
                const metadata = await probeFile(cacheFile);
                const duration = metadata && metadata.format && metadata.format.duration ? Math.floor(metadata.format.duration) : 0;

                if (duration === 0) {
                    console.warn('Cached file has zero duration, redownloading:', cacheFile);
                    this.downloadAndCache(this.current.url, cacheFile, 0);
                    return;
                }

                this.current.duration = duration + 5;
                this.streamFromCache(cacheFile);
            } catch (err) {
                console.error('Error probing cached file:', err.message);
                this.downloadAndCache(this.current.url, cacheFile, 0);
            }
        } else {
            this.downloadAndCache(this.current.url, cacheFile, 0);
        }
    }

    downloadAndCache(url, outputFile, retryCount = 0) {
        console.log('Downloading:', url);
        // Загружаем в файл
        const proc = spawn('yt-dlp', [
            '-o', outputFile,
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            '--no-playlist',
            '--no-cache-dir',
            '--js-runtime', 'node',
            url
        ]);

        this.downloadProcess = proc;

        proc.on('close', code => {
            if (code === 0) {
                console.log('Download completed successfully:', outputFile);
                // Получаем duration из загруженного файла
                ffmpeg.ffprobe(outputFile, async (err, metadata) => {
                    if (err) {
                        console.error('Error probing downloaded file:', err.message);
                        await this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                        return;
                    }
                    
                    const duration = metadata && metadata.format && metadata.format.duration ? Math.floor(metadata.format.duration) : 0;
                    
                    if (duration === 0) {
                        console.error('Downloaded file has zero duration');
                        await this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                        return;
                    }
                    
                    this.current.duration = duration + 5;
                    console.log('Duration of downloaded file:', duration);
                    this.streamFromCache(outputFile);
                });
            } else {
                if (retryCount < 1) {
                    console.log('Retrying download...');
                    this.downloadAndCache(url, outputFile, retryCount + 1);
                } else {
                    console.error('yt-dlp failed after retry');
                    // Испускаем событие об ошибке загрузки
                    if (this.current && this.current.redemptionData) {
                        this.emit('downloadError', {
                            track: this.current,
                            reason: 'Не удалось загрузить трек'
                        });
                    }
                    this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                }
                return;
            }
        });

        proc.on('error', (err) => {
            if (retryCount < 1) {
                console.log('Retrying download due to error...');
                this.downloadAndCache(url, outputFile, retryCount + 1);
            } else {
                console.error('Download failed after retry:', err.message);
                // Испускаем событие об ошибке загрузки
                if (this.current && this.current.redemptionData) {
                    this.emit('downloadError', {
                        track: this.current,
                        reason: err.message || 'Ошибка загрузки'
                    });
                }
                this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
            }
        });
    }

    streamFromCache(cacheFile) {
        if (!fs.existsSync(cacheFile)) {
            console.error('Cache file not found:', cacheFile);
            this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
            throw new Error(`Что-то сломалось, это не ваша вина...`);
            return;
        }

        this.currentCacheFile = cacheFile;
        this.startedAt = Date.now();
        this.emit('trackStart', this.current);

        if (!this.current.duration || this.current.duration <= 0) {
            console.error('Некорректная длительность');
            this.current = null;
            this.currentCacheFile = null;
            this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
            return;
        }

        if (this.cancelledProcessIds.size > 100) {
            this.cancelledProcessIds.clear();
        }

    }

    getCacheFileName(url) {
        // Генерируем имя файла на основе URL
        const hash = url.split('=')[1] || url.substring(url.length - 11);
        return `${hash}.m4a`;
    }

    skip() {
        if (this.backgroundProcessId !== null) {
            this.cancelledProcessIds.add(this.backgroundProcessId);
        }

        if (this.ffmpegProcess) {
            try {
                if (typeof this.ffmpegProcess.kill === 'function') {
                    this.ffmpegProcess.kill();
                }
            } catch (err) {
                console.error('Error killing ffmpeg:', err.message);
            }
            try {
                this.downloadProcess.kill('SIGKILL');
            } catch (err) {
                console.error('Error killing download:', err.message);
            }
            this.downloadProcess = null;
        }

        this.emit('skip');
        this.current = null;
        this.currentCacheFile = null;
        this.isPaused = false;
        this.pausedAt = 0;
        this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
    }

    pause() {
        if (!this.current || this.isPaused) return false;
        this.isPaused = true;
        this.pausedAt = Date.now() - this.startedAt;
        this.emit('pause');
        return true;
    }

    play() {
        if (!this.current || !this.isPaused) return false;
        this.isPaused = false;
        this.startedAt = Date.now() - this.pausedAt;
        this.emit('play');
        return true;
    }

    getState() {
        if (!this.current) return null;

        const elapsed = this.isPaused
            ? this.pausedAt
            : (this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0);

        return {
            title: this.current.title,
            requestedBy: this.current.requestedBy,
            duration: this.current.duration,
            elapsed: elapsed,
            isPaused: this.isPaused
        };
    }
}

// очищаем YouTube URL
function cleanYouTubeUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'youtu.be') {
            return `https://www.youtube.com/watch?v=${parsed.pathname.slice(1)}`;
        }
        if (parsed.hostname.includes('youtube.com')) {
            const videoId = parsed.searchParams.get('v');
            if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return url;
    } catch {
        return url;
    }
}

module.exports = new MusicQueue();