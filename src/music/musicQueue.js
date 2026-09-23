const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { cancelRedemption } = require('../bot/twitchApi');

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
        return 'YouTube требует проверку. Проверьте cookies в YT_DLP_COOKIES и работу bgutil PO Token provider на 127.0.0.1:4416';
    }
    if (/HTTP Error 403|HTTP Error 429|Forbidden/i.test(text)) {
        return 'YouTube заблокировал запрос (403/429). Проверьте cookies в YT_DLP_COOKIES, установленный bgutil-ytdlp-pot-provider и сервер на 127.0.0.1:4416';
    }
    if (/Missing required Visitor Data/i.test(text)) {
        return 'bgutil не смог получить Visitor Data. Проверьте, что bgutil-ytdlp-pot-provider установлен и сервер работает на 127.0.0.1:4416';
    }

    return text;
}

function buildYtDlpExtraArgs() {
    const args = parseYtDlpExtraArgs(process.env.YT_DLP_EXTRA_ARGS || '');
    const argsText = args.join(' ');
    const cookiesPath = process.env.YT_DLP_COOKIES || path.join(process.cwd(), 'cookies.txt');

    if (fs.existsSync(cookiesPath) && !/(^|\s)--cookies(?:-from-browser)?(?:\s|$)/.test(argsText)) {
        args.push('--cookies', cookiesPath);
    }

    const potProvider = process.env.YT_DLP_POT_PROVIDER || 'bgutil:http';
    if (potProvider !== 'off' && !/youtubepot-bgutil(?::)?(?:http|script)/.test(argsText)) {
        const potServerUrl = process.env.YT_DLP_POT_SERVER_URL || 'http://127.0.0.1:4416';
        const providerName = potProvider.replace(':', '');
        args.push('--extractor-args', `youtubepot-${providerName}:base_url=${potServerUrl}`);
    }

    const poToken = process.env.YT_DLP_PO_TOKEN;
    const visitorData = process.env.YT_DLP_VISITOR_DATA;
    if ((poToken || visitorData) && !/po_token=/.test(argsText)) {
        const extractorArgs = [];
        if (poToken) extractorArgs.push(`po_token=web+${poToken}`);
        if (visitorData) extractorArgs.push(`visitor_data=${visitorData}`);
        args.push('--extractor-args', `youtube:${extractorArgs.join(';')}`);
    }

    return args;
}

function buildYtDlpSpawnSpec(extraArgs = []) {
    const candidates = [];
    const envArgs = buildYtDlpExtraArgs();
    const mergedArgs = [...envArgs, ...extraArgs];

    if (process.env.YT_DLP_PATH) {
        candidates.push({ command: process.env.YT_DLP_PATH, args: mergedArgs });
    }

    if (process.platform === 'win32') {
        const winCommand = (command, ...args) => ({
            command: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', command, ...args]
        });

        candidates.push(winCommand('yt-dlp.exe', ...mergedArgs));
        candidates.push(winCommand('yt-dlp.cmd', ...mergedArgs));
        candidates.push(winCommand('py', '-3', '-m', 'yt_dlp', ...mergedArgs));
        candidates.push(winCommand('py', '-m', 'yt_dlp', ...mergedArgs));
    } else {
        candidates.push({ command: 'yt-dlp', args: mergedArgs });
        candidates.push({ command: 'python3', args: ['-m', 'yt_dlp', ...mergedArgs] });
        candidates.push({ command: 'python', args: ['-m', 'yt_dlp', ...mergedArgs] });
    }

    return candidates;
}

function spawnYtDlp(extraArgs = []) {
    const candidates = buildYtDlpSpawnSpec(extraArgs);
    const bundledToolPaths = [
        path.dirname(ffmpegPath),
        path.dirname(ffprobePath.path || ffprobePath)
    ];
    const spawnEnv = {
        ...process.env,
        PATH: [...bundledToolPaths, process.env.PATH || ''].join(path.delimiter)
    };

    return new Promise((resolve, reject) => {
        let lastError = null;

        const tryNext = (index) => {
            if (index >= candidates.length) {
                return reject(lastError || new Error('yt-dlp не найден и не удалось найти fallback-способ запуска'));
            }

            const { command, args } = candidates[index];
            const child = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: spawnEnv,
                shell: false
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

async function probeDuration(filePath) {
    const metadata = await probeFile(filePath);
    const duration = metadata?.format?.duration;
    return duration ? Math.floor(duration) : 0;
}

const CACHE_DIR = path.join(__dirname, 'audio_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const MAX_DURATIONS = { 1: 180, 2: 420, 3: 1800 };
const MAX_DOWNLOAD_RETRIES = 2;
const MAX_QUEUE_LENGTH = Number(process.env.MUSIC_MAX_QUEUE || 15);
const MAX_TRACKS_PER_USER = Number(process.env.MUSIC_MAX_PER_USER || 2);
const CACHE_MAX_FILES = Number(process.env.MUSIC_CACHE_MAX_FILES || 100);
const CACHE_MAX_BYTES = Number(process.env.MUSIC_CACHE_MAX_MB || 500) * 1024 * 1024;
// Запас поверх реальной длительности: если звук закончился, а overlay не
// сообщил об этом (закрыт, заблокирован autoplay) — сервер сам идёт дальше.
const WATCHDOG_GRACE_SEC = 20;
const WATCHDOG_INTERVAL_MS = 5000;

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class MusicQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.current = null;
        this.currentCacheFile = null;
        this.startedAt = null;
        this.cache = new Map();
        this.downloadPromises = new Map();
        this.downloadProcesses = new Map();
        this.cancelledDownloads = new Set();
        this.ffmpegProcess = null;
        this.downloadProcess = null;
        this.isPaused = false;
        this.pausedAt = 0;
        this.playbackGeneration = 0;
        this.lastAutoAdvanceAt = 0;
        this.shutdownRequested = false;
        this.sleepModeEnabled = false;
        this.sleepPlaylistPath = null;
        this.sleepPlaylistEntries = [];
        this.sleepPlaylistIndex = 0;
        this.sleepPlaylistName = 'Не задан';

        this.watchdogTimer = setInterval(() => this.watchdogTick(), WATCHDOG_INTERVAL_MS);
        if (typeof this.watchdogTimer.unref === 'function') {
            this.watchdogTimer.unref();
        }
    }

    watchdogTick() {
        const state = this.getState();
        if (!state || state.isPaused || this.shutdownRequested) return;
        if (state.duration > 0 && state.elapsed > state.duration + WATCHDOG_GRACE_SEC) {
            console.warn(`[music-order] watchdog: overlay не сообщил об окончании, перехожу к следующему треку (title=${state.title})`);
            this.skip();
        }
    }

    sanitizePathInput(input) {
        if (input === null || input === undefined) return '';

        let value = String(input).trim();
        if (!value) return '';

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1).trim();
        }

        if (value.startsWith('/[') && value.endsWith(']()')) {
            value = value.slice(2, -3).trim();
        } else if (value.startsWith('[') && value.endsWith(']()')) {
            value = value.slice(1, -3).trim();
        } else if (value.startsWith('/[') && value.endsWith(']')) {
            value = value.slice(2, -1).trim();
        } else if (value.startsWith('[') && value.endsWith(']')) {
            value = value.slice(1, -1).trim();
        }

        if (value.startsWith('/')) {
            if (/^\/[a-zA-Z]:/.test(value)) {
                value = value.slice(1);
            }
        }

        return value;
    }

    resolveLocalPath(input) {
        const trimmed = this.sanitizePathInput(input);
        if (!trimmed) return null;
        if (trimmed.startsWith('file://')) {
            return decodeURIComponent(trimmed.replace(/^file:\/\//i, ''));
        }
        if (trimmed.startsWith('~/')) {
            return path.resolve(process.env.HOME || process.cwd(), trimmed.slice(2));
        }
        if (path.isAbsolute(trimmed)) {
            return trimmed;
        }
        return path.resolve(trimmed);
    }

    isLikelyLocalPath(input) {
        const trimmed = this.sanitizePathInput(input);
        if (!trimmed) return false;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return false;
        if (trimmed.startsWith('file://')) return true;
        if (trimmed.startsWith('~/')) return true;
        if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return true;
        if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
        if (trimmed.includes('/') || trimmed.includes('\\')) return true;
        return false;
    }

    decodeXmlEntities(text = '') {
        return text
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
    }

    parseXspfPlaylist(filePath) {
        const resolvedPath = this.resolveLocalPath(filePath);
        if (!resolvedPath || !fs.existsSync(resolvedPath)) {
            throw new Error(`XSPF-плейлист не найден: ${filePath}`);
        }

        const content = fs.readFileSync(resolvedPath, 'utf8');
        const matches = [...content.matchAll(/<location[^>]*>([\s\S]*?)<\/location>/gi)];
        const baseDir = path.dirname(resolvedPath);

        return matches
            .map((match) => {
                const rawValue = (match[1] || '').replace(/<[^>]+>/g, '').trim();
                if (!rawValue) return null;
                const decodedValue = this.decodeXmlEntities(rawValue);
                const trimmed = this.sanitizePathInput(decodedValue);

                if (!trimmed) return null;
                if (trimmed.startsWith('file://')) {
                    return this.resolveLocalPath(trimmed);
                }
                if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                    return trimmed;
                }
                if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
                    return this.resolveLocalPath(trimmed);
                }
                return path.resolve(baseDir, trimmed);
            })
            .filter(Boolean);
    }

    resolveTrackCandidates(query) {
        const trimmed = (query || '').trim();
        if (!trimmed) return [];

        const isXspf = /\.xspf$/i.test(trimmed) && this.isLikelyLocalPath(trimmed);
        if (isXspf) {
            return this.parseXspfPlaylist(trimmed).map((entry) => {
                const resolved = this.isLikelyLocalPath(entry) ? this.resolveLocalPath(entry) : entry;
                return {
                    sourceType: this.isLikelyLocalPath(entry) ? 'local' : 'remote',
                    value: entry,
                    filePath: this.isLikelyLocalPath(entry) ? resolved : undefined,
                    cacheKey: entry
                };
            });
        }

        if (this.isLikelyLocalPath(trimmed)) {
            const resolved = this.resolveLocalPath(trimmed);
            return [{ sourceType: 'local', value: resolved, filePath: resolved, cacheKey: resolved }];
        }

        const url = cleanYouTubeUrl(trimmed);
        return [{ sourceType: 'remote', value: url, cacheKey: url }];
    }

    buildLocalTrack(filePath, username, level, redemptionData, originalQuery) {
        const resolvedPath = this.resolveLocalPath(filePath);
        return {
            id: crypto.randomUUID(),
            title: path.basename(resolvedPath),
            url: originalQuery || resolvedPath,
            duration: 0,
            requestedBy: username,
            level,
            redemptionData,
            sourceType: 'local',
            filePath: resolvedPath
        };
    }

    countUserTracks(username) {
        const inQueue = this.queue.filter(track => track.requestedBy === username).length;
        const current = this.current && this.current.requestedBy === username ? 1 : 0;
        return inQueue + current;
    }

    async add(query, username, level, redemptionData = null, options = {}) {
        const trimmed = (query || '').trim();
        const allowLocal = Boolean(options.allowLocal);
        const orderId = redemptionData?.redemptionId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        console.log(`[music-order] received orderId=${orderId} user=${username} level=${level} query=${trimmed}`);

        const candidates = this.resolveTrackCandidates(trimmed);
        if (!candidates.length) {
            throw new Error('Не удалось определить источник музыки');
        }

        const hasLocalCandidate = candidates.some(candidate => candidate.sourceType === 'local');
        if (hasLocalCandidate && !allowLocal) {
            throw new Error('Локальные пути разрешены только из user interface');
        }

        if (this.queue.length + (this.current ? 1 : 0) >= MAX_QUEUE_LENGTH) {
            throw new Error(`Очередь переполнена (максимум ${MAX_QUEUE_LENGTH}), попробуйте позже`);
        }
        if (this.countUserTracks(username) >= MAX_TRACKS_PER_USER) {
            throw new Error(`У ${username} уже максимум треков в очереди (${MAX_TRACKS_PER_USER})`);
        }

        const queuedTracks = [];

        for (const candidate of candidates) {
            const cacheKey = candidate.cacheKey || trimmed;
            let track;

            if (candidate.sourceType === 'local') {
                const resolvedPath = this.resolveLocalPath(candidate.value);
                const duplicateLocal = [this.current, ...this.queue].find(existing =>
                    existing && existing.sourceType === 'local' && existing.filePath === resolvedPath
                );
                if (duplicateLocal) {
                    throw new Error(duplicateLocal === this.current ? 'Этот трек уже играет' : 'Этот трек уже в очереди');
                }
                track = this.buildLocalTrack(candidate.value, username, level, redemptionData, trimmed);
            } else {
                const url = candidate.value;
                const duplicate = [this.current, ...this.queue].find(existing =>
                    existing && existing.sourceType === 'remote' && cleanYouTubeUrl(existing.url) === url
                );
                if (duplicate) {
                    throw new Error(duplicate === this.current ? 'Этот трек уже играет' : 'Этот трек уже в очереди');
                }

                if (this.cache.has(cacheKey)) {
                    track = { ...this.cache.get(cacheKey), id: crypto.randomUUID(), requestedBy: username, redemptionData, level };
                } else {
                    const info = await this.getInfo(url);
                    if (info.duration > MAX_DURATIONS[level]) {
                        throw new Error(`Трек слишком длинный (макс ${Math.floor(MAX_DURATIONS[level] / 60)} мин)`);
                    }

                    track = {
                        id: crypto.randomUUID(),
                        title: info.title,
                        url: info.webpage_url || url,
                        duration: info.duration || 0,
                        requestedBy: username,
                        level,
                        redemptionData,
                        sourceType: 'remote'
                    };
                    this.cache.set(cacheKey, track);
                }
            }

            this.queue.push(track);
            queuedTracks.push(track);
        }

        this.emit('stateChanged', this.getPublicState());
        console.log(`[music-order] queued orderId=${orderId} queueLength=${this.queue.length}`);

        // Треки качаются сразу при заказе, а не когда дойдут до проигрывания:
        // переход между треками становится практически мгновенным.
        for (const track of queuedTracks) {
            if (track.sourceType === 'remote') {
                this.prefetchTrack(track);
            }
        }

        if (!this.current) {
            this.playNext().catch(err => console.error('Ошибка запуска очереди:', err.message));
        }

        return queuedTracks[0];
    }

    prefetchTrack(track) {
        this.ensureTrackReady(track).catch(err => {
            if (this.current === track) return; // сбой текущего трека обрабатывает startCurrentTrack
            const index = this.queue.indexOf(track);
            if (index === -1) return; // трек уже убрали из очереди (например, очисткой)

            this.queue.splice(index, 1);
            console.error(`[music-order] prefetch failed title=${track.title} reason=${err.message}`);
            if (track.redemptionData) {
                this.emit('downloadError', { track, reason: err.message });
            }
            this.emit('stateChanged', this.getPublicState());
        });
    }

    getInfo(query) {
        return new Promise(async (resolve, reject) => {
            try {
                const isUrl = /^https?:\/\//i.test(query);
                const searchQuery = isUrl ? query : `ytsearch1:${query}`;

                // '--' закрывает список опций: запрос из чата не сможет
                // притвориться флагом yt-dlp
                const yt = await spawnYtDlp([
                    '--no-update',
                    '-j',
                    '--no-playlist',
                    '--js-runtime', 'node',
                    '--',
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
        console.log(`[music-order] playNext start current=${this.current ? this.current.title : 'none'} queueLength=${this.queue.length}`);
        this.playbackGeneration += 1;
        const generation = this.playbackGeneration;

        if (this.current && this.current.sourceType === 'remote') {
            this.killDownloadForUrl(this.current.url);
        }

        if (this.queue.length > 0) {
            this.current = this.queue.shift() || null;
        } else if (this.sleepModeEnabled && this.sleepPlaylistEntries.length > 0) {
            this.current = this.buildSleepTrack();
        } else {
            this.current = null;
        }

        if (!this.current) {
            console.log('[music-order] playNext finished: queue empty');
            this.currentCacheFile = null;
            this.isPaused = false;
            this.pausedAt = 0;
            this.emit('stateChanged', this.getPublicState());
            return;
        }

        await this.startCurrentTrack(generation);
    }

    buildSleepTrack() {
        if (!this.sleepPlaylistEntries.length) {
            return null;
        }

        const entry = this.sleepPlaylistEntries[this.sleepPlaylistIndex];
        this.sleepPlaylistIndex = (this.sleepPlaylistIndex + 1) % this.sleepPlaylistEntries.length;

        return {
            id: crypto.randomUUID(),
            title: entry.title,
            url: entry.source,
            duration: 0,
            requestedBy: 'Спящий плейлист',
            level: 0,
            redemptionData: null,
            sourceType: entry.sourceType,
            filePath: entry.filePath || null,
            isSleepTrack: true
        };
    }

    async startCurrentTrack(generation) {
        const currentTrack = this.current;
        if (!currentTrack) return;

        const logPrefix = currentTrack.isSleepTrack ? 'sleep-track' : 'track';
        const sourcePath = currentTrack.filePath || currentTrack.url;
        console.log(`[music-order] starting ${logPrefix} orderId=${currentTrack.redemptionData?.redemptionId || 'unknown'} title=${currentTrack.title} source=${sourcePath}`);

        try {
            if (currentTrack.sourceType === 'local') {
                const resolvedPath = this.resolveLocalPath(currentTrack.filePath);
                if (!fs.existsSync(resolvedPath)) {
                    throw new Error(`Локальный файл не найден: ${resolvedPath}`);
                }
                const duration = await probeDuration(resolvedPath);
                if (duration <= 0) {
                    throw new Error(`Локальный файл имеет нулевую длительность: ${resolvedPath}`);
                }
                if (generation !== this.playbackGeneration || this.current !== currentTrack) return;
                currentTrack.duration = duration;
                this.streamFromCache(resolvedPath);
                return;
            }

            const { file, duration } = await this.ensureTrackReady(currentTrack);
            if (generation !== this.playbackGeneration || this.current !== currentTrack) {
                console.log(`[music-order] stale generation ${generation}, ignoring start`);
                return;
            }
            if (!fs.existsSync(file)) {
                throw new Error(`Файл трека не найден: ${file}`);
            }

            currentTrack.duration = duration;
            this.streamFromCache(file);
        } catch (err) {
            // Если трек уже не текущий (его скипнули/очистили) — ошибка неактуальна
            if (generation !== this.playbackGeneration || this.current !== currentTrack) {
                console.log(`[music-order] stale start ${generation}, ignoring error: ${err.message}`);
                return;
            }
            console.error(`[music-order] failed to start track title=${currentTrack.title}: ${err.message}`);
            if (currentTrack.redemptionData) {
                this.emit('downloadError', { track: currentTrack, reason: err.message });
            }
            this.skip();
        }
    }

    getCacheFilePath(url) {
        const name = path.basename(url || 'track') || 'track';
        const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const hash = crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 12);
        return path.join(CACHE_DIR, `${hash}_${safeName || 'track'}.mp3`);
    }

    async probeCacheFile(cacheFile) {
        if (!fs.existsSync(cacheFile)) return null;
        try {
            const duration = await probeDuration(cacheFile);
            if (duration <= 0) {
                console.warn(`[music-order] cache file has zero duration, will redownload: ${cacheFile}`);
                return null;
            }
            return { file: cacheFile, duration };
        } catch (err) {
            console.error('Error probing cached file:', err.message);
            return null;
        }
    }

    // Гарантирует, что трек лежит в кэше готовым к проигрыванию.
    // Параллельные вызовы для одного URL садятся на одну загрузку.
    async ensureTrackReady(track) {
        if (track.sourceType === 'local') {
            return { file: track.filePath, duration: 0 };
        }

        const cacheFile = this.getCacheFilePath(track.url);
        const cached = await this.probeCacheFile(cacheFile);
        if (cached) {
            track.duration = cached.duration;
            return cached;
        }

        let promise = this.downloadPromises.get(cacheFile);
        if (!promise) {
            promise = this.runDownload(track.url, cacheFile, 0)
                .finally(() => this.downloadPromises.delete(cacheFile));
            this.downloadPromises.set(cacheFile, promise);
        }

        const result = await promise;
        track.duration = result.duration;
        this.cleanupCache().catch(err => console.error('Ошибка очистки кэша:', err.message));
        return result;
    }

    async runDownload(url, outputFile, retryCount) {
        let proc;
        try {
            // '--' перед url закрывает список опций yt-dlp
            proc = await spawnYtDlp([
                '--no-update',
                '-o', outputFile,
                '-f', 'bestaudio/best',
                '--retries', '3',
                '--fragment-retries', '3',
                '--retry-sleep', 'http:exp=2:10',
                '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '0',
                '--no-playlist',
                '--no-cache-dir',
                '--js-runtime', 'node',
                '--',
                url
            ]);
        } catch (err) {
            if (retryCount < MAX_DOWNLOAD_RETRIES) {
                await wait(2000 * (retryCount + 1));
                return this.runDownload(url, outputFile, retryCount + 1);
            }
            throw new Error(err.message || 'Ошибка запуска yt-dlp');
        }

        const cacheKey = path.basename(outputFile);
        this.downloadProcesses.set(cacheKey, proc);
        this.downloadProcess = proc; // для gracefulShutdown

        return new Promise((resolve, reject) => {
            let stderr = '';
            proc.stderr.on('data', chunk => stderr += chunk.toString());

            proc.on('close', async code => {
                if (this.downloadProcesses.get(cacheKey) === proc) {
                    this.downloadProcesses.delete(cacheKey);
                }
                if (this.cancelledDownloads.has(cacheKey)) {
                    this.cancelledDownloads.delete(cacheKey);
                    return reject(new Error('Загрузка отменена'));
                }
                if (code !== 0) {
                    if (retryCount < MAX_DOWNLOAD_RETRIES) {
                        await wait(3000 * (retryCount + 1));
                        try {
                            resolve(await this.runDownload(url, outputFile, retryCount + 1));
                        } catch (retryErr) {
                            reject(retryErr);
                        }
                        return;
                    }
                    const reason = stderr.trim() ? `yt-dlp failed: ${normalizeYtDlpError(stderr)}` : 'Не удалось загрузить трек';
                    return reject(new Error(reason));
                }

                const duration = await probeDuration(outputFile).catch(() => 0);
                if (duration <= 0) {
                    return reject(new Error('Загруженный файл имеет нулевую длительность'));
                }
                console.log(`[music-order] download completed file=${outputFile} duration=${duration}`);
                resolve({ file: outputFile, duration });
            });

            proc.on('error', async err => {
                if (this.downloadProcesses.get(cacheKey) === proc) {
                    this.downloadProcesses.delete(cacheKey);
                }
                if (this.cancelledDownloads.has(cacheKey)) {
                    this.cancelledDownloads.delete(cacheKey);
                    return reject(new Error('Загрузка отменена'));
                }
                if (retryCount >= MAX_DOWNLOAD_RETRIES) {
                    return reject(new Error(err.message || 'Ошибка загрузки'));
                }
                await wait(2000 * (retryCount + 1));
                try {
                    resolve(await this.runDownload(url, outputFile, retryCount + 1));
                } catch (retryErr) {
                    reject(retryErr);
                }
            });
        });
    }

    killDownloadForUrl(url) {
        const cacheFile = this.getCacheFilePath(url);
        const cacheKey = path.basename(cacheFile);
        const proc = this.downloadProcesses.get(cacheKey);
        if (!proc) return;
        this.cancelledDownloads.add(cacheKey);
        this.downloadProcesses.delete(cacheKey);
        try {
            proc.kill('SIGKILL');
        } catch (err) {
            console.error('Error killing download:', err.message);
        }
    }

    // Держит кэш в рамках MUSIC_CACHE_MAX_FILES / MUSIC_CACHE_MAX_MB,
    // удаляя самые старые файлы (кроме играющего и загружаемых).
    async cleanupCache() {
        const entries = [];
        for (const name of fs.readdirSync(CACHE_DIR)) {
            const filePath = path.join(CACHE_DIR, name);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) continue;
                entries.push({ filePath, size: stat.size, mtime: stat.mtimeMs });
            } catch {
                // файл мог исчезнуть между readdir и stat
            }
        }

        const protectedFiles = new Set([this.currentCacheFile]);
        for (const cacheFile of this.downloadPromises.keys()) {
            protectedFiles.add(cacheFile);
        }

        entries.sort((a, b) => a.mtime - b.mtime); // самые старые первыми
        let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
        let remaining = entries.length;
        let removed = 0;

        for (const entry of entries) {
            if (remaining <= CACHE_MAX_FILES && totalSize <= CACHE_MAX_BYTES) break;
            if (protectedFiles.has(entry.filePath)) continue;
            try {
                fs.unlinkSync(entry.filePath);
                totalSize -= entry.size;
                remaining -= 1;
                removed += 1;
            } catch (err) {
                console.error(`Не удалось удалить кэш-файл ${entry.filePath}:`, err.message);
            }
        }

        if (removed > 0) {
            console.log(`[music-order] cache cleanup removed=${removed} filesLeft=${remaining} totalMB=${Math.round(totalSize / 1024 / 1024)}`);
        }
    }

    streamFromCache(cacheFile) {
        this.currentCacheFile = cacheFile;
        this.startedAt = Date.now();
        this.isPaused = false;
        this.pausedAt = 0;
        console.log(`[music-order] track start title=${this.current?.title} requestedBy=${this.current?.requestedBy} duration=${this.current?.duration} cacheFile=${cacheFile}`);
        this.emit('trackStart', this.current);
        this.emit('stateChanged', this.getPublicState());
    }

    // Автопереход: клиент сообщил, что звук закончился. trackId и дебаунс
    // защищают от двойных скипов (несколько overlay-клиентов, повторные ended).
    advanceEnded(trackId) {
        if (!this.current || !trackId || this.current.id !== trackId) {
            return false;
        }
        const now = Date.now();
        if (now - this.lastAutoAdvanceAt < 1500) {
            return false;
        }
        this.lastAutoAdvanceAt = now;
        this.skip();
        return true;
    }

    skip() {
        if (this.current && this.current.sourceType === 'remote') {
            this.killDownloadForUrl(this.current.url);
        }

        this.emit('skip');
        this.current = null;
        this.currentCacheFile = null;
        this.isPaused = false;
        this.pausedAt = 0;
        this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
    }

    async clearQueue() {
        const removedTracks = this.queue.splice(0, this.queue.length);
        for (const track of removedTracks) {
            if (track.sourceType === 'remote' && (!this.current || this.current.url !== track.url)) {
                this.killDownloadForUrl(track.url);
            }
        }
        if (!removedTracks.length) {
            this.emit('stateChanged', this.getPublicState());
            return { cleared: 0, refunded: 0, failed: 0 };
        }

        let refunded = 0;
        let failed = 0;

        for (const track of removedTracks) {
            if (track.redemptionData) {
                try {
                    await cancelRedemption({
                        broadcasterId: process.env.BROADCASTER_ID,
                        rewardId: track.redemptionData.rewardId,
                        redemptionId: track.redemptionData.redemptionId,
                        userId: track.redemptionData.userId,
                        accessToken: process.env.TWITCH_TOKEN_MY,
                        clientId: process.env.CLIENT_ID_MY
                    });
                    refunded += 1;
                } catch (err) {
                    failed += 1;
                    console.error(`Ошибка возврата баллов для ${track.requestedBy || 'пользователя'}:`, err.message || err);
                }
            }
        }

        this.emit('stateChanged', this.getPublicState());
        console.log(`[music-order] queue cleared cleared=${removedTracks.length} refunded=${refunded} failed=${failed}`);
        return { cleared: removedTracks.length, refunded, failed };
    }

    pause() {
        if (!this.current || this.isPaused) return false;
        this.isPaused = true;
        this.pausedAt = Date.now() - this.startedAt;
        this.emit('pause');
        this.emit('stateChanged', this.getPublicState());
        return true;
    }

    play() {
        if (!this.current || !this.isPaused) return false;
        this.isPaused = false;
        this.startedAt = Date.now() - this.pausedAt;
        this.emit('play');
        this.emit('stateChanged', this.getPublicState());
        return true;
    }

    getState() {
        // Трек "существует" для клиентов только когда /audio уже может его
        // отдавать. Иначе overlay подставит src до готовности файла, получит
        // 404 и не будет повторять — тишина до ручного обновления источника.
        if (!this.current || !this.currentCacheFile) return null;

        const elapsed = this.isPaused
            ? this.pausedAt
            : (this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0);

        return {
            trackId: this.current.id,
            title: this.current.title,
            requestedBy: this.current.requestedBy,
            duration: this.current.duration,
            elapsed: elapsed,
            isPaused: this.isPaused,
            sourceType: this.current.sourceType || 'remote',
            isSleepTrack: Boolean(this.current.isSleepTrack)
        };
    }

    getQueueSnapshot() {
        return {
            current: this.current ? {
                title: this.current.title,
                requestedBy: this.current.requestedBy,
                duration: this.current.duration,
                sourceType: this.current.sourceType || 'remote',
                isPaused: this.isPaused,
                isSleepTrack: Boolean(this.current.isSleepTrack)
            } : null,
            upcoming: this.queue.slice(0, 8).map(track => ({
                title: track.title,
                requestedBy: track.requestedBy,
                sourceType: track.sourceType || 'remote',
                isSleepTrack: Boolean(track.isSleepTrack)
            })),
            queueLength: this.queue.length
        };
    }

    getPublicState() {
        const baseState = this.getState();
        return {
            ...(baseState || {}),
            sleepModeEnabled: this.sleepModeEnabled,
            sleepPlaylistName: this.sleepPlaylistName,
            queueLength: this.queue.length,
            currentSource: this.current?.filePath || this.current?.url || null
        };
    }

    async setSleepPlaylist(source) {
        const trimmed = (source || '').trim();
        if (!trimmed) {
            this.sleepPlaylistPath = null;
            this.sleepPlaylistEntries = [];
            this.sleepPlaylistName = 'Не задан';
            this.sleepModeEnabled = false;
            this.emit('stateChanged', this.getPublicState());
            return { enabled: false, name: this.sleepPlaylistName };
        }

        const resolvedPath = this.resolveLocalPath(trimmed);
        if (!resolvedPath || !fs.existsSync(resolvedPath)) {
            throw new Error('Плейлист не найден на диске');
        }

        if (/\.xspf$/i.test(resolvedPath)) {
            const entries = this.parseXspfPlaylist(resolvedPath);
            this.sleepPlaylistEntries = entries.map((entry) => {
                const normalized = this.isLikelyLocalPath(entry) ? this.resolveLocalPath(entry) : entry;
                return {
                    title: path.basename(normalized),
                    source: entry,
                    sourceType: this.isLikelyLocalPath(entry) ? 'local' : 'remote',
                    filePath: this.isLikelyLocalPath(entry) ? this.resolveLocalPath(entry) : null
                };
            });
            this.sleepPlaylistPath = resolvedPath;
            this.sleepPlaylistName = path.basename(resolvedPath);
        } else {
            this.sleepPlaylistEntries = [{
                title: path.basename(resolvedPath),
                source: resolvedPath,
                sourceType: 'local',
                filePath: resolvedPath
            }];
            this.sleepPlaylistPath = resolvedPath;
            this.sleepPlaylistName = path.basename(resolvedPath);
        }

        this.sleepPlaylistIndex = 0;
        this.sleepModeEnabled = true;
        if (!this.current) {
            this.playNext().catch(err => console.error('Ошибка запуска спящего плейлиста:', err.message));
        }
        this.emit('stateChanged', this.getPublicState());
        return { enabled: true, name: this.sleepPlaylistName };
    }

    setSleepMode(enabled) {
        this.sleepModeEnabled = Boolean(enabled);
        if (this.sleepModeEnabled && !this.current && this.sleepPlaylistEntries.length > 0) {
            this.playNext().catch(err => console.error('Ошибка запуска спящего плейлиста:', err.message));
        }
        this.emit('stateChanged', this.getPublicState());
        return this.sleepModeEnabled;
    }

    getSleepState() {
        return {
            enabled: this.sleepModeEnabled,
            playlistPath: this.sleepPlaylistPath,
            playlistName: this.sleepPlaylistName,
            entries: this.sleepPlaylistEntries.length,
            queueLength: this.queue.length
        };
    }
}

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

const musicQueue = new MusicQueue();

musicQueue.__testHooks = {
    parseXspfPlaylist: (filePath) => musicQueue.parseXspfPlaylist(filePath),
    resolveTrackCandidates: (query) => musicQueue.resolveTrackCandidates(query),
    buildYtDlpSpawnSpec: (extraArgs = []) => buildYtDlpSpawnSpec(extraArgs),
    normalizeYtDlpError: (stderr = '') => normalizeYtDlpError(stderr)
};

module.exports = musicQueue;