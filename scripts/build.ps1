# Quiet Inbox - one-step Windows build.
# Run "Build Quiet Inbox.bat" (double-click). This script:
#   1. installs Node.js LTS if it is missing or too old (winget, or the official installer as a fallback)
#   2. asks once for the Microsoft client ID and saves oauth.config.json
#   3. installs packages, builds the installer and portable .exe, and opens the dist folder
# Safe to run again any time; it skips whatever is already done.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$MinNode = 20

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host ""
  Write-Host "BUILD FAILED: $text" -ForegroundColor Red
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:ProgramFiles\nodejs"
}

function Get-NodeMajor {
  try {
    $v = (& node -v) 2>$null
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

function Install-NodeWithWinget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
  Write-Host "    Installing Node.js LTS with winget (Windows may ask for permission)..."
  & winget install --exact --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
  return ((Get-NodeMajor) -ge $MinNode)
}

function Install-NodeFromNodejsOrg {
  Write-Host "    Downloading the Node.js LTS installer from nodejs.org..."
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $file = "node-$($lts.version)-$arch.msi"
  $msi = Join-Path $env:TEMP $file
  Invoke-WebRequest "https://nodejs.org/dist/$($lts.version)/$file" -OutFile $msi
  Write-Host "    Running the installer (Windows will ask for permission)..."
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { return $false }
  Refresh-Path
  return ((Get-NodeMajor) -ge $MinNode)
}

Write-Host "Quiet Inbox build" -ForegroundColor White
Write-Host "Folder: $Root"

# ---- 1. Node.js -------------------------------------------------------------
Step "Checking for Node.js $MinNode or newer"
Refresh-Path
$major = Get-NodeMajor
if ($major -ge $MinNode) {
  Ok "Found Node.js $((& node -v))"
} else {
  if ($major -gt 0) { Warn "Node.js $((& node -v)) is too old. Installing the current LTS." }
  else { Warn "Node.js isn't installed. Installing it now." }
  $installed = $false
  try { $installed = Install-NodeWithWinget } catch { Warn "winget didn't work: $($_.Exception.Message)" }
  if (-not $installed) {
    try { $installed = Install-NodeFromNodejsOrg } catch { Warn "Download didn't work: $($_.Exception.Message)" }
  }
  if (-not $installed) { Fail "Couldn't install Node.js. Install the LTS version from https://nodejs.org, then run this again." }
  Ok "Installed Node.js $((& node -v))"
}

# ---- 2. Microsoft sign-in ID ------------------------------------------------
Step "Checking Microsoft sign-in (needed for MSN, Outlook, Hotmail)"
$configPath = Join-Path $Root 'oauth.config.json'
$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$current = $null
if (Test-Path $configPath) {
  try { $current = (Get-Content $configPath -Raw | ConvertFrom-Json).microsoftClientId } catch { }
}
if ($current -and $current -match $guid -and $current -ne '00000000-0000-0000-0000-000000000000') {
  Ok "Using client ID $current"
} else {
  Write-Host "    Paste the Application (client) ID from your Entra app registration."
  Write-Host "    (See README, 'Turn on Sign in with Microsoft'. Press Enter to skip; you can add it later in Settings.)"
  while ($true) {
    $id = (Read-Host "    Client ID").Trim()
    if (-not $id) { Warn "Skipped. You can add it later in Quiet Inbox Settings, no rebuild needed."; break }
    if ($id -match $guid) {
      ('{ "microsoftClientId": "' + $id + '" }') | Set-Content -Path $configPath -Encoding ASCII
      Ok "Saved oauth.config.json"
      break
    }
    Warn "That doesn't look like a client ID (it looks like 1a2b3c4d-1111-2222-3333-444455556666). Try again."
  }
}

# ---- 3. Packages ------------------------------------------------------------
Step "Installing packages (the first time takes a few minutes)"
$ErrorActionPreference = 'Continue'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'
if (Test-Path (Join-Path $Root 'package-lock.json')) { & npm ci --no-fund --no-audit } else { & npm install --no-fund --no-audit }
if ($LASTEXITCODE -ne 0) {
  Warn "Clean install failed; trying a normal install."
  & npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't install packages. Check the internet connection and try again." }
}
Ok "Packages ready"

Step "Quick self-check"
& node test/oauth.test.js
if ($LASTEXITCODE -ne 0) { Fail "The Microsoft sign-in self-check failed." }

# ---- 4. Build ---------------------------------------------------------------
Step "Building Quiet Inbox"
Get-Process -Name 'Quiet Inbox' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'   # no code-signing certificate
$log = Join-Path $env:TEMP 'quiet-inbox-build.log'
$builder = Join-Path $Root 'node_modules\.bin\electron-builder.cmd'
# electron-builder prints progress on stderr; Windows PowerShell 5.1 would treat that as a fatal error.
$ErrorActionPreference = 'Continue'
& $builder --win nsis portable 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log | Out-Host
if ($LASTEXITCODE -ne 0) {
  # electron-builder's Windows tools archive contains symlinks that need admin rights or Developer Mode
  # to unpack. Retry without editing the .exe resources, which doesn't need those tools.
  if (Select-String -Path $log -Pattern 'symbolic link|winCodeSign|rcedit' -Quiet) {
    Warn "Retrying without the Windows resource editor (needs no admin rights)..."
    & $builder --win nsis portable -c.win.signAndEditExecutable=false 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log | Out-Host
  }
  if ($LASTEXITCODE -ne 0) { Fail "The build didn't finish. The full log is in $log" }
}

$dist = Join-Path $Root 'dist'
$setup = Get-ChildItem $dist -Filter 'Quiet Inbox Setup*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$portable = Get-ChildItem $dist -Filter 'QuietInbox-Portable*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Fail "The build said it finished, but no installer was found in $dist" }

Write-Host ""
Write-Host "DONE" -ForegroundColor Green
Write-Host "  Installer: $($setup.FullName)"
if ($portable) { Write-Host "  Portable:  $($portable.FullName)" }
Write-Host ""
Write-Host "  Copy the installer to grandma's PC (USB stick, email, or cloud) and double-click it."
Write-Host "  Windows may say 'Windows protected your PC': choose More info, then Run anyway."
Start-Process explorer.exe -ArgumentList "/select,`"$($setup.FullName)`""
Write-Host ""
$answer = Read-Host "Install it on THIS computer now too? (y/N)"
if ($answer -match '^[yY]') { Start-Process $setup.FullName }
