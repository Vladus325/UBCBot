const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const musicQueue = require('../src/music/musicQueue');

test('parseXspfPlaylist extracts local track locations', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubcbot-'));
  const playlistPath = path.join(tmpDir, 'sleep.xspf');
  const trackPath = path.join(tmpDir, 'track1.mp3');
  fs.writeFileSync(trackPath, 'fake audio');
  fs.writeFileSync(playlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <trackList>
    <track><location>${trackPath}</location></track>
  </trackList>
</playlist>`);

  const tracks = musicQueue.__testHooks.parseXspfPlaylist(playlistPath);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0], trackPath);
});

test('resolveTrackCandidates supports local file paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubcbot-'));
  const trackPath = path.join(tmpDir, 'ambient.mp3');
  fs.writeFileSync(trackPath, 'fake audio');

  const tracks = musicQueue.__testHooks.resolveTrackCandidates(trackPath);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].sourceType, 'local');
  assert.equal(tracks[0].filePath, trackPath);
});

test('buildYtDlpSpawnSpec avoids shell-based spawning', () => {
  const previousProvider = process.env.YT_DLP_POT_PROVIDER;
  try {
    process.env.YT_DLP_POT_PROVIDER = 'off';
    const spec = musicQueue.__testHooks.buildYtDlpSpawnSpec(['--foo']);
    assert.equal(spec[0].command, process.env.YT_DLP_PATH || (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'yt-dlp'));
    assert.equal(spec[0].args[0], process.platform === 'win32' ? '/d' : '--foo');
  } finally {
    if (previousProvider === undefined) delete process.env.YT_DLP_POT_PROVIDER;
    else process.env.YT_DLP_POT_PROVIDER = previousProvider;
  }
});

test('buildYtDlpSpawnSpec configures the bgutil HTTP PO Token provider', () => {
  const previousProvider = process.env.YT_DLP_POT_PROVIDER;
  const previousServerUrl = process.env.YT_DLP_POT_SERVER_URL;
  try {
    process.env.YT_DLP_POT_PROVIDER = 'bgutil:http';
    process.env.YT_DLP_POT_SERVER_URL = 'http://127.0.0.1:4416';
    const spec = musicQueue.__testHooks.buildYtDlpSpawnSpec(['--foo']);
    assert.match(spec[0].args.join(' '), /youtubepot-bgutilhttp:base_url=http:\/\/127\.0\.0\.1:4416/);
  } finally {
    if (previousProvider === undefined) delete process.env.YT_DLP_POT_PROVIDER;
    else process.env.YT_DLP_POT_PROVIDER = previousProvider;
    if (previousServerUrl === undefined) delete process.env.YT_DLP_POT_SERVER_URL;
    else process.env.YT_DLP_POT_SERVER_URL = previousServerUrl;
  }
});

test('buildYtDlpSpawnSpec adds cookies and PO Token from environment', () => {
  const previous = {
    cookies: process.env.YT_DLP_COOKIES,
    poToken: process.env.YT_DLP_PO_TOKEN,
    visitorData: process.env.YT_DLP_VISITOR_DATA,
    extraArgs: process.env.YT_DLP_EXTRA_ARGS
  };
  const cookiePath = path.join(os.tmpdir(), 'ubcbot-cookies.txt');
  fs.writeFileSync(cookiePath, '# Netscape HTTP Cookie File');

  try {
    process.env.YT_DLP_COOKIES = cookiePath;
    process.env.YT_DLP_PO_TOKEN = 'po-token';
    process.env.YT_DLP_VISITOR_DATA = 'visitor-data';
    process.env.YT_DLP_EXTRA_ARGS = '';

    const spec = musicQueue.__testHooks.buildYtDlpSpawnSpec(['--foo']);
    const args = spec[0].args.join(' ');
    assert.match(args, new RegExp(`--cookies ${cookiePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(args, /--extractor-args youtube:po_token=web\+po-token;visitor_data=visitor-data/);
  } finally {
    fs.unlinkSync(cookiePath);
    for (const [key, value] of Object.entries({
      YT_DLP_COOKIES: previous.cookies,
      YT_DLP_PO_TOKEN: previous.poToken,
      YT_DLP_VISITOR_DATA: previous.visitorData,
      YT_DLP_EXTRA_ARGS: previous.extraArgs
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('normalizeYtDlpError explains YouTube 403 blocks with the cookie workaround', () => {
  const message = musicQueue.__testHooks.normalizeYtDlpError('ERROR: unable to download video data: HTTP Error 403: Forbidden');
  assert.match(message, /HTTP 403|Forbidden|cookies|bgutil|4416/i);
});

test('local paths are rejected outside the UI context', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubcbot-'));
  const trackPath = path.join(tmpDir, 'private.mp3');
  fs.writeFileSync(trackPath, 'fake audio');

  await assert.rejects(
    () => musicQueue.add(trackPath, 'tester', 1, null, { allowLocal: false }),
    /local|user interface/i
  );
});

test('parseXspfPlaylist strips quotes and wrapper characters from paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubcbot-'));
  const playlistPath = path.join(tmpDir, 'sleep.xspf');
  const trackPath = path.join(tmpDir, 'wrapped.mp3');
  fs.writeFileSync(trackPath, 'fake audio');
  fs.writeFileSync(playlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <trackList>
    <track><location>"/[${trackPath}]()"</location></track>
  </trackList>
</playlist>`);

  const tracks = musicQueue.__testHooks.parseXspfPlaylist(playlistPath);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0], trackPath);
});
