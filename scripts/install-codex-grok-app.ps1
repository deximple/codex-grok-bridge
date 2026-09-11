# Install or update the dedicated Codex Grok desktop wrapper on Windows.
# Writes %LOCALAPPDATA%\codex-grok-bridge\app only. Never writes WindowsApps.
param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$App = if ($env:CODEX_GROK_APP) { $env:CODEX_GROK_APP } else { Join-Path $env:LOCALAPPDATA "codex-grok-bridge\app" }
$UserData = Join-Path $env:LOCALAPPDATA "codex-grok-bridge\desktop"

if ($App -match "(?i)WindowsApps") {
  Write-Error "refusing to install into the stock ChatGPT/Codex prefix: $App"
}

if (-not $Force) {
  $hit = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*--user-data-dir=$UserData*" }
  if ($hit) {
    Write-Error "Codex Grok is running. Close its window first, or pass -Force."
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $App "scripts"), (Join-Path $App "src") | Out-Null
Copy-Item (Join-Path $Root "scripts\*.mjs") (Join-Path $App "scripts") -Force
Copy-Item (Join-Path $Root "src\*.mjs") (Join-Path $App "src") -Force

$Node = if ($env:NODE) { $env:NODE } else { (Get-Command node -ErrorAction Stop).Source }
$Launcher = Join-Path $App "codex-grok-desktop.cmd"
@"
@echo off
set ROOT=%~dp0
"$Node" "%ROOT%scripts\launch-desktop.mjs" %*
"@ | Set-Content -Path $Launcher -Encoding ASCII

$StartDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-Item -ItemType Directory -Force -Path $StartDir | Out-Null
Copy-Item $Launcher (Join-Path $StartDir "Codex Grok.cmd") -Force

function Write-StorePointer([string]$Name, [string[]]$Filters) {
  $pointerDir = Split-Path -Parent $App
  if ($pointerDir -match "(?i)WindowsApps") { return }
  $pkgs = @(Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "OpenAI\.(ChatGPT|Codex)|ChatGPT" })
  if (-not $pkgs) {
    $pkgs = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "OpenAI\.(ChatGPT|Codex)|ChatGPT" })
  }
  foreach ($filter in $Filters) {
    foreach ($pkg in $pkgs) {
      if (-not $pkg.InstallLocation) { continue }
      $hit = Get-ChildItem -Path $pkg.InstallLocation -Filter $filter -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $hit) { continue }
      New-Item -ItemType Directory -Force -Path $pointerDir | Out-Null
      Set-Content -Path (Join-Path $pointerDir $Name) -Value $hit.FullName -Encoding ASCII
      Write-Output "store pointer $Name=$($hit.FullName)"
      return
    }
  }
}

Write-StorePointer "store-app.txt" @("ChatGPT.exe", "Codex.exe")
Write-StorePointer "store-codex.txt" @("codex.exe")

Write-Output "win32 wrapper $Launcher"
Write-Output "bridge in $App matches $Root"
Write-Output "restart any open Codex Grok window to load it"
