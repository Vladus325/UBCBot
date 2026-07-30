const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

    return new Promise((resolve, reject) => {
        let lastError = null;

        const tryNext = (index) => {
            if (index >= candidates.length) {
                return reject(lastError || new Error('yt-dlp не найден и не удалось найти fallback-способ запуска'));
            }

            const { command, args } = candidates[index];
            const child = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
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
        this.sleepModeEnabled = false;
        this.sleepPlaylistPath = null;
        this.sleepPlaylistEntries = [];
        this.sleepPlaylistIndex = 0;
        this.sleepPlaylistName = 'Не задан';
    }

    async showMusicTicker() {
        await setSourceVisibility(OBS_MUSIC_TICKER_SOURCE, true);
    }

    async hideMusicTicker() {
        await setSourceVisibility(OBS_MUSIC_TICKER_SOURCE, false);
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

        return [{ sourceType: 'remote', value: cleanYouTubeUrl(trimmed), cacheKey: trimmed }];
    }

    buildLocalTrack(filePath, username, level, redemptionData, originalQuery) {
        const resolvedPath = this.resolveLocalPath(filePath);
        return {
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
        if (!candidates.length) {
            throw new Error('Не удалось определить источник музыки');
        }

        const queuedTracks = [];

        for (const candidate of candidates) {
            const cacheKey = candidate.cacheKey || trimmed;
            let track;

            if (candidate.sourceType === 'local') {
                track = this.buildLocalTrack(candidate.value, username, level, redemptionData, trimmed);
            } else if (this.cache.has(cacheKey)) {
                track = { ...this.cache.get(cacheKey), requestedBy: username, redemptionData, level };
            } else {
                const info = await this.getInfo(candidate.value);
                if (info.duration > MAX_DURATIONS[level]) {
                    throw new Error(`Трек слишком длинный (макс ${Math.floor(MAX_DURATIONS[level] / 60)} мин)`);
                }

                track = {
                    title: info.title,
                    url: info.webpage_url || candidate.value,
                    duration: info.duration || 0,
                    requestedBy: username,
                    level,
                    redemptionData,
                    sourceType: 'remote'
                };
                this.cache.set(cacheKey, track);
            }

            this.queue.push(track);
            queuedTracks.push(track);
        }

        this.emit('stateChanged', this.getPublicState());
        console.log(`[music-order] queued orderId=${orderId} queueLength=${this.queue.length}`);
        this.hideMusicTicker().catch(err => console.error('OBS: не удалось скрыть бегущую строку:', err.message));

        try {
            if (!this.current) {
                this.playNext().catch(err => console.error('Ошибка запуска очереди:', err.message));
            }
        } catch (err) {
            throw new Error(`Ошибка: ${err.message || err}`);
        }

        return queuedTracks[0];
    }

    getInfo(query) {
        return new Promise(async (resolve, reject) => {
            try {
                const isUrl = /^https?:\/\//i.test(query);
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

        if (this.queue.length > 0) {
            this.current = this.queue.shift() || null;
        } else if (this.sleepModeEnabled && this.sleepPlaylistEntries.length > 0) {
            this.current = this.buildSleepTrack();
        } else {
            this.current = null;
        }

        if (!this.current) {
            console.log('[music-order] playNext finished: queue empty');
            await this.showMusicTicker();
            this.emit('stateChanged', this.getPublicState());
            return;
        }

        await this.hideMusicTicker();
        await this.startCurrentTrack(generation);
    }

    buildSleepTrack() {
        if (!this.sleepPlaylistEntries.length) {
            return null;
        }

        const entry = this.sleepPlaylistEntries[this.sleepPlaylistIndex];
        this.sleepPlaylistIndex = (this.sleepPlaylistIndex + 1) % this.sleepPlaylistEntries.length;

        return {
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

        const sourcePath = currentTrack.filePath || currentTrack.url;
        const logPrefix = currentTrack.isSleepTrack ? 'sleep-track' : 'track';
        console.log(`[music-order] starting ${logPrefix} orderId=${currentTrack.redemptionData?.redemptionId || 'unknown'} title=${currentTrack.title} source=${sourcePath}`);

        if (currentTrack.sourceType === 'local' && currentTrack.filePath) {
            const resolvedPath = this.resolveLocalPath(currentTrack.filePath);
            if (!fs.existsSync(resolvedPath)) {
                console.error(`[music-order] local file not found: ${resolvedPath}`);
                this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                return;
            }

            try {
                const metadata = await probeFile(resolvedPath);
                const duration = metadata && metadata.format && metadata.format.duration ? Math.floor(metadata.format.duration) : 0;
                if (duration <= 0) {
                    console.warn(`[music-order] local file has zero duration: ${resolvedPath}`);
                    this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
                    return;
                }
                currentTrack.duration = duration + 5;
                this.streamFromCache(resolvedPath);
            } catch (err) {
                console.error('Error probing local track:', err.message);
                this.playNext().catch(err => console.error('Ошибка перехода к следующему треку:', err.message));
            }
            return;
        }

        const cacheFile = path.join(CACHE_DIR, this.getCacheFileName(sourcePath));
        if (fs.existsSync(cacheFile)) {
            console.log(`[music-order] cache-hit file=${cacheFile}`);
            const expectedUrl = currentTrack?.url;
            try {
                const metadata = await probeFile(cacheFile);
                const duration = metadata && metadata.format && metadata.format.duration ? Math.floor(metadata.format.duration) : 0;

                if (duration === 0) {
                    console.warn(`[music-order] cache file has zero duration, redownloading: ${cacheFile}`);
                    this.downloadAndCache(currentTrack.url, cacheFile, 0, generation);
                    return;
                }

                if (generation !== this.playbackGeneration || !this.current || this.current.url !== expectedUrl) {
                    return;
                }

                this.current.duration = duration + 5;
                this.streamFromCache(cacheFile);
            } catch (err) {
                console.error('Error probing cached file:', err.message);
                this.downloadAndCache(currentTrack.url, cacheFile, 0, generation);
            }
        } else {
            this.downloadAndCache(currentTrack.url, cacheFile, 0, generation);
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
            throw new Error('Что-то сломалось, это не ваша вина...');
        }

        this.currentCacheFile = cacheFile;
        this.startedAt = Date.now();
        console.log(`[music-order] track start title=${this.current?.title} requestedBy=${this.current?.requestedBy} cacheFile=${cacheFile}`);
        this.emit('trackStart', this.current);
        this.emit('stateChanged', this.getPublicState());

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
        const name = path.basename(url || 'track') || 'track';
        const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const hash = crypto.createHash('md5').update(String(url)).digest('hex').slice(0, 10);
        return `${hash}_${safeName || 'track'}`;
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
        if (!this.current) return null;

        const elapsed = this.isPaused
            ? this.pausedAt
            : (this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0);

        return {
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
    buildYtDlpSpawnSpec: (extraArgs = []) => buildYtDlpSpawnSpec(extraArgs)
};

module.exports = musicQueue;