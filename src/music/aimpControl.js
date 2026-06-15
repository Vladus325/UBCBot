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

function encodePowershellCommand(command) {
    return Buffer.from(command, 'utf16le').toString('base64');
}

function execPowershell(command) {
    return new Promise((resolve, reject) => {
        const encodedCommand = encodePowershellCommand(command);
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand], {
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

async function sendAppCommand(command) {
    if (!await isWindows()) {
        console.warn('AIMP media control работает только на Windows.');
        return false;
    }

    const aimpRunning = await isAimpRunning();
    if (!aimpRunning) {
        console.warn('AIMP не запущен, пропускаем media command.');
        return false;
    }

    const script = `
if (-not ([Type]::GetType("Win32.NativeMethods"))) {
    $cs = @"
using System;
using System.Runtime.InteropServices;

namespace Win32 {
    public static class NativeMethods {
        public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
        public const int WM_APPCOMMAND = 0x0319;

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageW(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
    }
}
"@
    Add-Type -TypeDefinition $cs -Language CSharp;
}
$hwnd = [Win32.NativeMethods]::HWND_BROADCAST
$cmd = [IntPtr](${command} -shl 16)
$result = [Win32.NativeMethods]::SendMessageW($hwnd, [Win32.NativeMethods]::WM_APPCOMMAND, [IntPtr]::Zero, $cmd)
if ($result -eq [IntPtr]::Zero) { Write-Error 'SendMessageW returned zero'; exit 1 }
`;

    try {
        await execPowershell(script);
        return true;
    } catch (err) {
        console.error('Ошибка отправки AppCommand:', err.message);
        return false;
    }
}

async function sendMediaVirtualKey(vk) {
    const script = `
if (-not ('Keyboard' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Keyboard {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@ -Language CSharp
}
[Keyboard]::keybd_event(${vk}, 0, 0x0001, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[Keyboard]::keybd_event(${vk}, 0, 0x0001 -bor 0x0002, [UIntPtr]::Zero)
`;

    try {
        await execPowershell(script);
        return true;
    } catch (err) {
        console.error('Ошибка отправки virtual key:', err.message);
        return false;
    }
}

async function sendMediaPlayPause() {
    const appResult = await sendAppCommand(14);
    const keyResult = await sendMediaVirtualKey(0xB3);
    return appResult || keyResult;
}

async function sendMediaPlay() {
    const appResult = await sendAppCommand(46);
    const keyResult = await sendMediaVirtualKey(0xFA);
    if (appResult || keyResult) {
        return true;
    }

    return sendMediaPlayPause();
}

async function sendMediaPause() {
    // Only pause if AIMP is running
    const running = await isAimpRunning();
    if (!running) {
        return false;
    }
    // AIMP doesn't handle separate pause command (47), use play/pause toggle instead
    return sendMediaPlayPause();
}

module.exports = {
    isAimpRunning,
    startAimp,
    sendMediaPlayPause,
    sendMediaPlay,
    sendMediaPause
};
