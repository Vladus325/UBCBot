$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$providerRoot = Join-Path $repoRoot 'tools\bgutil-ytdlp-pot-provider'
$providerVersion = '1.3.1'
$providerUrl = 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git'
$pluginRoot = Join-Path $env:APPDATA 'yt-dlp\plugins\bgutil-ytdlp-pot-provider'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required. Install Git for Windows and run this script again.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required. Install Node.js 20+ and run this script again.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $providerRoot) | Out-Null
if (-not (Test-Path (Join-Path $providerRoot '.git'))) {
    git clone --depth 1 --branch $providerVersion $providerUrl $providerRoot
}

Push-Location (Join-Path $providerRoot 'server')
try {
    npm ci
    npx tsc
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
Copy-Item -Path (Join-Path $providerRoot 'plugin\*') -Destination $pluginRoot -Recurse -Force

Write-Host "bgutil-ytdlp-pot-provider $providerVersion installed."
Write-Host 'The bot will start the HTTP provider automatically from run_bot.bat.'
