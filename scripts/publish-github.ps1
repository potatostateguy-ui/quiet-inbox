# Quiet Inbox - upload (or update) the project on GitHub.
# Run "Upload to GitHub.bat" (double-click). This script:
#   1. installs Git and the GitHub CLI if they're missing (winget)
#   2. signs you in to GitHub in your browser (first time only)
#   3. creates a PRIVATE repository on your account and pushes the code
#      (or, if the repository already exists, pushes your latest changes)
# Safe to run again any time to upload new changes.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host ""; Write-Host "UPLOAD FAILED: $t" -ForegroundColor Red; Write-Host ""; Read-Host "Press Enter to close"; exit 1 }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:ProgramFiles\Git\cmd;$env:ProgramFiles\GitHub CLI"
}
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Ensure-Tool($cmd, $wingetId, $label) {
  Refresh-Path
  if (Have $cmd) { Ok "$label is installed"; return }
  if (-not (Have 'winget')) { Fail "$label isn't installed and winget isn't available. Install $label, then run this again." }
  Write-Host "    Installing $label (Windows may ask for permission)..."
  & winget install --exact --id $wingetId --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
  if (-not (Have $cmd)) { Fail "Couldn't install $label. Install it yourself, then run this again." }
  Ok "Installed $label"
}

Write-Host "Quiet Inbox - upload to GitHub" -ForegroundColor White
Write-Host "Folder: $Root"

# ---- 1. Tools -----------------------------------------------------------------
Step "Checking for Git and the GitHub CLI"
Ensure-Tool 'git' 'Git.Git' 'Git'
Ensure-Tool 'gh' 'GitHub.cli' 'GitHub CLI'

# ---- 2. Sign in -----------------------------------------------------------------
Step "Checking your GitHub sign-in"
& gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "    A browser window will open. Copy the one-time code shown here, paste it on GitHub, and approve."
  & gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0) { Fail "GitHub sign-in didn't finish." }
}
& gh auth setup-git *> $null
$login = (& gh api user --jq .login).Trim()
if (-not $login) { Fail "Couldn't read your GitHub username." }
Ok "Signed in as $login"

# ---- 3. Local repository ----------------------------------------------------------
Step "Preparing the project"
if (-not (Test-Path (Join-Path $Root '.git'))) {
  & git init -b main | Out-Null
  Ok "Started a new Git repository"
}
if (-not (& git config user.email)) {
  $id = (& gh api user --jq .id).Trim()
  & git config user.name $login
  & git config user.email "$id+$login@users.noreply.github.com"
  Ok "Using your private GitHub no-reply email for commits"
}
& git add -A
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  $msg = Read-Host "    Describe this upload (press Enter for 'Update Quiet Inbox')"
  if (-not $msg) { $msg = 'Update Quiet Inbox' }
  & git commit -m $msg | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't save the changes (git commit)." }
  Ok "Saved changes: $msg"
} else {
  Ok "No new changes since the last upload"
}
$branch = (& git rev-parse --abbrev-ref HEAD).Trim()

# ---- 4. GitHub repository -----------------------------------------------------------
Step "Uploading to GitHub"
& git remote get-url origin *> $null
if ($LASTEXITCODE -ne 0) {
  $name = Read-Host "    Repository name (press Enter for 'quiet-inbox')"
  if (-not $name) { $name = 'quiet-inbox' }
  & gh repo view "$login/$name" *> $null
  if ($LASTEXITCODE -eq 0) {
    Warn "$login/$name already exists on GitHub. Uploading into it."
    & git remote add origin "https://github.com/$login/$name.git"
    & git push -u origin $branch
  } else {
    $vis = Read-Host "    Make it public? Anyone could see the code. (y/N)"
    $flag = if ($vis -match '^[yY]') { '--public' } else { '--private' }
    & gh repo create $name $flag --source . --remote origin --push --description 'Quiet Inbox: a simple Windows email cleanup app'
  }
} else {
  & git push -u origin $branch
}
if ($LASTEXITCODE -ne 0) { Fail "The upload didn't finish. If GitHub has changes made on the website, pull them first (git pull) and run this again." }

$url = (& gh repo view --json url --jq .url).Trim()
Write-Host ""
Write-Host "DONE" -ForegroundColor Green
Write-Host "  $url"
Write-Host "  Run 'Upload to GitHub.bat' again any time to upload new changes."
Start-Process $url
Write-Host ""
Read-Host "Press Enter to close"
