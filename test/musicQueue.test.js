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
  const spec = musicQueue.__testHooks.buildYtDlpSpawnSpec(['--foo']);
  assert.equal(spec[0].command, process.env.YT_DLP_PATH || (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'yt-dlp'));
  assert.equal(spec[0].args[0], process.platform === 'win32' ? '/d' : '--foo');
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
