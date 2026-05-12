const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_AIMP_PATHS = [
    process.env.AIMP_PATH,
    'C:\\Program Files\\AIMP\\AIMP.exe',
    'C:\\Program Files (x86)\\AIMP\\AIMP.exe'
].filter(Boolean);

function findAimpExecutable() {
    return DEFAULT_AIMP_PATHS.find(fs.existsSync) || null;
}

function execPowershell(command) {
    return new Promise((resolve, reject) => {
        const proc = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', chunk => stdout += chunk.toString());
        proc.stderr.on('data', chunk => stderr += chunk.toString());

        proc.on('close', code => {
            if (code !== 0) {
                return reject(new Error(`PowerShell exited with code ${code}: ${stderr.trim()}`));
            }
            resolve(stdout.trim());
        });

        proc.on('error', reject);
    });
}

async function isWindows() {
    return process.platform === 'win32';
}

async function isAimpRunning() {
    if (!await isWindows()) return false;

    const command = `Get-Process -Name aimp -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }`;
    try {
        const output = await execPowershell(command);
        return Boolean(output);
    } catch (_) { // eslint-disable-line no-unused-vars
        return false;
    }
}

async function startAimp() {
    if (!await isWindows()) {
        console.warn('AIMP automation работает только на Windows.');
        return false;
    }

    const executable = findAimpExecutable();
    if (!executable) {
        console.warn('AIMP не найден. Укажите путь в переменной среды AIMP_PATH или установите AIMP в Program Files.');
        return false;
    }

    const alreadyRunning = await isAimpRunning();
    if (alreadyRunning) {
        return true;
    }

    try {
        const proc = spawn(executable, [], {
            detached: true,
            stdio: 'ignore'
        });
        proc.unref();
        return true;
    } catch (err) {
        console.error('Ошибка запуска AIMP:', err.message);
        return false;
    }
}

async function sendMediaPlayPause() {
    if (!await isWindows()) {
        console.warn('AIMP media hotkey работает только на Windows.');
        return false;
    }

    const aimpRunning = await isAimpRunning();
    if (!aimpRunning) {
        console.warn('AIMP не запущен, пропускаем Media Play/Pause.');
        return false;
    }

    const script = `
if (-not ('Keyboard' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Keyboard {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@ -Language CSharp
}
[Keyboard]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero);
Start-Sleep -Milliseconds 100;
[Keyboard]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero);
`;

    try {
        await execPowershell(script);
        return true;
    } catch (err) {
        console.error('Ошибка отправки Media Play/Pause:', err.message);
        return false;
    }
}

module.exports = {
    isAimpRunning,
    startAimp,
    sendMediaPlayPause
};
