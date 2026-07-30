const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { setSourceVisibility } = require('../bot/obsHook');

function parseYtDlpExtraArgs(rawArgs = '') {
    const args = [];
    let current = '';
    let quote = null;

    for (const char of rawArgs.trim()) {
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current) {
        args.push(current);
    }

    return args;
}

function normalizeYtDlpError(stderr = '') {
    const text = stderr.trim();
    if (!text) return 'unknown error';

    if (/Sign in to confirm/i.test(text)) {
        return 'требуется авторизация YouTube через cookies (см. README для YT_DLP_EXTRA_ARGS)';
    }
    if (/HTTP Error 429/i.test(text)) {
        return 'Too Many Requests (429) — попробуйте передать cookies или сменить браузерные данные';
    }
    if (/Missing required Visitor Data/i.test(text)) {
        return 'Не хватает Visitor Data; используйте --extractor-args "youtube:visitor_data=XXX"';
    }

    return text;
}

function buildYtDlpSpawnSpec(extraArgs = []) {
    const candidates = [];
    const envArgs = parseYtDlpExtraArgs(process.env.YT_DLP_EXTRA_ARGS || '');
    const mergedArgs = [...envArgs, ...extraArgs];

    if (process.env.YT_DLP_PATH) {
        candidates.push({ command: process.env.YT_DLP_PATH, args: mergedArgs });
    }

    if (process.platform === 'win32') {
        candidates.push({ command: 'yt-dlp.exe', args: mergedArgs });
        candidates.push({ command: 'yt-dlp.cmd', args: mergedArgs });
        candidates.push({ command: 'py', args: ['-3', '-m', 'yt_dlp', ...mergedArgs] });
        candidates.push({ command: 'py', args: ['-m', 'yt_dlp', ...mergedArgs] });
    } else {
        candidates.push({ command: 'yt-dlp', args: mergedArgs });
        candidates.push({ command: 'python3', args: ['-m', 'yt_dlp', ...mergedArgs] });
        candidates.push({ command: 'python', args: ['-m', 'yt_dlp', ...mergedArgs] });
    }

    return candidates;
}

function spawnYtDlp(extraArgs = []) {
    const candidates = buildYtDlpSpawnSpec(extraArgs);

    return new Promise((resolve, reject) => {
        let lastError = null;

        const tryNext = (index) => {
            if (index >= candidates.length) {
                return reject(lastError || new Error('yt-dlp не найден и не удалось найти fallback-способ запуска'));
            }

            const { command, args } = candidates[index];
            const child = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: process.platform === 'win32' && !command.includes(path.sep)
            });

            child.once('error', (err) => {
                lastError = err;
                tryNext(index + 1);
            });

            child.once('spawn', () => resolve(child));
        };

        tryNext(0);
    });
}

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
        this.isPaused = false;
        this.pausedAt = 0;
        this.playbackGeneration = 0;
    }

    async showMusicTicker() {
        await setSourceVisibility(OBS_MUSIC_TICKER_SOURCE, true);
    }

    async hideMusicTicker() {
        await setSourceVisibility(OBS_MUSIC_TICKER_SOURCE, false);
    }

    async add(query, username, level, redemptionData = null) {
        query = cleanYouTubeUrl(query);
        const orderId = redemptionData?.redemptionId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        console.log(`[music-order] received orderId=${orderId} user=${username} level=${level} query=${query}`);

        // проверка кэша
        if (this.cache.has(query)) {
            const cached = { ...this.cache.get(query), requestedBy: username, redemptionData };
            this.queue.push(cached);
            console.log(`[music-order] cache-hit orderId=${orderId} title=${cached.title}`);
            this.hideMusicTicker().catch(err => console.error('OBS: не удалось скрыть бегущую строку:', err.message));

            try {
                if (!this.current) {
                    this.playNext().catch(err => console.error('Ошибка запуска очереди:', err.message));
                }
            } catch (err) {
                throw new Error(`Ошибка: ${err.message || err}`);
            }
            return cached;
        }

        console.log(`[music-order] resolving info orderId=${orderId}`);
        const info = await this.getInfo(query);

        if (info.duration > MAX_DURATIONS[level]) {
            throw new Error(`Трек слишком длинный (макс ${Math.floor(MAX_DURATIONS[level] / 60)} мин)`);
        }

        console.log(`[music-order] resolved orderId=${orderId} title=${info.title} url=${info.webpage_url} duration=${info.duration || 0}`);

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
        console.log(`[music-order] queued orderId=${orderId} queueLength=${this.queue.length}`);
        this.hideMusicTicker().catch(err => console.error('OBS: не удалось скрыть бегущую строку:', err.message));

        try {
            if (!this.current) {
                this.playNext().catch(err => console.error('Ошибка запуска очереди:', err.message));
            }
        } catch (err) {
            throw new Error(`Ошибка: ${err.message || err}`);
        }

        return track;
    }

    getInfo(query) {
        return new Promise(async (resolve, reject) => {
            try {
                // Check if query is a URL
                const isUrl = query.startsWith('http://') || query.startsWith('https://');
                const searchQuery = isUrl ? query : `ytsearch1:${query}`;

                const yt = await spawnYtDlp([
                    '--no-update',
                    '-j',
                    '--no-playlist',
                    '--js-runtime', 'node',
                    searchQuery
                ]);

                let data = '';
                let stderr = '';
                yt.stdout.on('data', chunk => data += chunk.toString());
                yt.stderr.on('data', chunk => stderr += chunk.toString());

                yt.on('close', code => {
                    if (code !== 0) {
                        return reject(new Error(`yt-dlp failed (${code}): ${normalizeYtDlpError(stderr)}`));
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch {
                        reject(new Error(`Ошибка парсинга yt-dlp JSON: ${stderr.trim() || 'empty response'}`));
                    }
                });

                yt.on('error', reject);
            } catch (err) {
                reject(err);
            }
        });
    }

    async playNext() {
        const currentTrack = this.current;
        console.log(`[music-order] playNext start current=${currentTrack ? currentTrack.title : 'none'} queueLength=${this.queue.length}`);
        this.playbackGeneration += 1;
        const generation = this.playbackGeneration;

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
            console.log('[music-order] playNext finished: queue empty');
            await this.showMusicTicker();
            return;
        }

        await this.hideMusicTicker();

        // Генерируем имя файла кэша
        const cacheFile = path.join(CACHE_DIR, this.getCacheFileName(this.current.url));
        console.log(`[music-order] starting track orderId=${this.current.redemptionData?.redemptionId || 'unknown'} title=${this.current.title} cacheFile=${cacheFile}`);
        
        // Проверяем, есть ли уже в кэше
        if (fs.existsSync(cacheFile)) {
            console.log(`[music-order] cache-hit file=${cacheFile}`);
            const expectedUrl = this.current?.url;
            try {
                const metadata = await probeFile(cacheFile);
                const duration = metadata && metadata.format && metadata.format.duration ? Math.floor(metadata.format.duration) : 0;

                if (duration === 0) {
                    console.warn(`[music-order] cache file has zero duration, redownloading: ${cacheFile}`);
                    this.downloadAndCache(this.current.url, cacheFile, 0, generation);
                    return;
                }

                if (generation !== this.playbackGeneration || !this.current || this.current.url !== expectedUrl) {
                    return;
                }

                this.current.duration = duration + 5;
                this.streamFromCache(cacheFile);
            } catch (err) {
                console.error('Error probing cached file:', err.message);
                this.downloadAndCache(this.current.url, cacheFile, 0, generation);
            }
        } else {
            this.downloadAndCache(this.current.url, cacheFile, 0, generation);
        }
    }

    async downloadAndCache(url, outputFile, retryCount = 0, generation = this.playbackGeneration) {
        const currentTrack = this.current;
        const currentUrl = currentTrack ? currentTrack.url : url;

        console.log(`[music-order] downloading url=${url} output=${outputFile} retry=${retryCount} generation=${generation}`);

        let proc;
        try {
            proc = await spawnYtDlp([
                '--no-update',
                '-o', outputFile,
                '-f', 'bestaudio[ext=m4a]/bestaudio',
                '--no-playlist',
                '--no-cache-dir',
                '--js-runtime', 'node',
                url
            ]);
        } catch (err) {
            console.error(`[music-order] yt-dlp spawn failed: ${err.message}`);
            if (retryCount < 1) {
                console.log('Retrying download due to spawn error...');
                return this.downloadAndCache(url, outputFile, retryCount + 1, generation);
            }

            if (this.current && this.current.redemptionData) {
                this.emit('downloadError', {
                    track: this.current,
                    reason: err.message || 'Ошибка запуска yt-dlp'
                });
            }
            this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
            return;
        }

        this.downloadProcess = proc;
        let stderr = '';
        proc.stderr.on('data', chunk => stderr += chunk.toString());

        proc.on('close', async code => {
            if (this.downloadProcess === proc) {
                this.downloadProcess = null;
            }
            if (generation !== this.playbackGeneration || this.current?.url !== currentUrl) {
                return;
            }

            if (code === 0) {
                console.log(`[music-order] download completed output=${outputFile} currentTitle=${this.current?.title || 'none'} generation=${generation}`);
                try {
                    const metadata = await probeFile(outputFile);
                    const duration = metadata && metadata.format && metadata.format.duration ? Math.floor(metadata.format.duration) : 0;
                    console.log(`[music-order] probe result output=${outputFile} duration=${duration}`);

                    if (duration === 0) {
                        console.error(`[music-order] downloaded file has zero duration output=${outputFile}`);
                        await this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                        return;
                    }

                    if (generation !== this.playbackGeneration) {
                        console.log(`[music-order] stale generation ignored generation=${generation} currentGeneration=${this.playbackGeneration}`);
                        return;
                    }

                    this.current.duration = duration + 5;
                    console.log(`[music-order] track ready title=${this.current?.title} duration=${duration}`);
                    this.streamFromCache(outputFile);
                } catch (err) {
                    console.error('Error probing downloaded file:', err.message);
                    await this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                }
            } else {
                if (retryCount < 1) {
                    console.log('Retrying download...');
                    await this.downloadAndCache(url, outputFile, retryCount + 1, generation);
                } else {
                    const reason = stderr.trim() ? `yt-dlp failed: ${normalizeYtDlpError(stderr)}` : 'Не удалось загрузить трек';
                    console.error(`[music-order] download failed reason=${reason}`);
                    if (this.current && this.current.redemptionData) {
                        this.emit('downloadError', {
                            track: this.current,
                            reason
                        });
                    }
                    this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                }
                return;
            }
        });

        proc.on('error', async err => {
            if (generation !== this.playbackGeneration || this.current?.url !== currentUrl) {
                return;
            }

            if (retryCount < 1) {
                console.log('Retrying download due to error...');
                await this.downloadAndCache(url, outputFile, retryCount + 1, generation);
            } else {
                console.error(`[music-order] download failed after retry: ${err.message}`);
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
        console.log(`[music-order] track start title=${this.current?.title} requestedBy=${this.current?.requestedBy} cacheFile=${cacheFile}`);
        this.emit('trackStart', this.current);

        if (!this.current.duration || this.current.duration <= 0) {
            console.error(`[music-order] invalid duration title=${this.current?.title}`);
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