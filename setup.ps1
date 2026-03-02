# ─────────────────────────────────────────────────────────────────────────────
# Synctx — One-Line Installer (Windows PowerShell)
#
# Usage:
#   irm https://raw.githubusercontent.com/adsathye/synctx/main/setup.ps1 | iex
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"

$Repo = "adsathye/synctx"
$InstallDir = Join-Path $env:USERPROFILE ".synctx-plugin"

Write-Host ""
Write-Host "  Synctx — Installer"
Write-Host ""

# ── Auto-Install Prerequisites ───────────────────────────────────────────────

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    # Also scan common install locations winget uses
    $extra = @(
        "$env:ProgramFiles\nodejs",
        "$env:ProgramFiles\Git\cmd",
        "$env:ProgramFiles\GitHub CLI",
        "$env:ProgramFiles\gitleaks",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
        "$env:LOCALAPPDATA\Programs\copilot-cli"
    )
    foreach ($p in $extra) {
        if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) {
            $env:Path += ";$p"
        }
    }
}

function Install-IfMissing($cmd, $wingetId, $label) {
    Write-Host "`r  * Checking $label...                                        " -NoNewline -ForegroundColor Cyan
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        return $true
    }
    Write-Host "`r  * Installing $label...                                      " -NoNewline -ForegroundColor Cyan
    try {
        winget install --id $wingetId --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null
        Refresh-Path
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            return $true
        } else {
            Write-Host "`r  ! $label needs terminal restart for PATH                    " -ForegroundColor Yellow
            return $true
        }
    } catch {
        Write-Host "`r  x Failed to install $label — winget install $wingetId       " -ForegroundColor Red
        return $false
    }
}

# Check winget is available first
if (-not (Get-Command "winget" -ErrorAction SilentlyContinue)) {
    Write-Host "  x winget required. Update Windows or install App Installer." -ForegroundColor Red
    exit 1
}

$allOk = $true
Write-Host "  * Checking prerequisites..." -NoNewline -ForegroundColor Cyan
if (-not (Install-IfMissing "node"     "OpenJS.NodeJS.LTS"  "Node.js"))    { $allOk = $false }
if (-not (Install-IfMissing "git"      "Git.Git"            "Git"))        { $allOk = $false }
if (-not (Install-IfMissing "gh"       "GitHub.cli"         "GitHub CLI")) { $allOk = $false }
if (-not (Install-IfMissing "gitleaks" "Gitleaks.Gitleaks"  "Gitleaks"))   { $allOk = $false }
if (-not (Install-IfMissing "copilot"  "GitHub.Copilot"     "Copilot CLI")){ $allOk = $false }

if ($allOk) {
    Write-Host "`r  $([char]0x2713) All prerequisites ready                                " -ForegroundColor Green
} else {
    Write-Host "`r  ! Some prerequisites need attention                          " -ForegroundColor Yellow
}

# Final check
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Host "  x Node.js not in PATH. Close terminal, reopen, re-run." -ForegroundColor Red
    exit 1
}

Write-Host ""

# ── Clone or Update ──────────────────────────────────────────────────────────

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "  * Updating Synctx..." -NoNewline -ForegroundColor Cyan
    git -C $InstallDir fetch --quiet origin main 2>$null
    git -C $InstallDir reset --quiet --hard origin/main 2>$null
    Write-Host "`r  $([char]0x2713) Updated to latest      " -ForegroundColor Green
} else {
    Write-Host "  * Downloading Synctx..." -NoNewline -ForegroundColor Cyan
    git clone --quiet "https://github.com/$Repo.git" $InstallDir 2>$null
    Write-Host "`r  $([char]0x2713) Downloaded             " -ForegroundColor Green
}

# ── Install ──────────────────────────────────────────────────────────────────

Write-Host ""
node (Join-Path $InstallDir "install.js")

Write-Host ""
Write-Host "  ─────────────────────────────────────────────"
Write-Host "  Synctx installed successfully!"
Write-Host ""
Write-Host "  Quick start:"
Write-Host "    synctx list                          # See your sessions"
Write-Host "    synctx tag <session-id> my-feature   # Tag a session"
Write-Host "    synctx restore my-feature            # Restore on any machine"
Write-Host ""
Write-Host "  Sessions sync automatically in the background."
Write-Host "  Use /synctx commands inside Copilot CLI."
Write-Host ""
Write-Host "  To update:  re-run this script"
Write-Host "  To remove:  synctx uninstall"
Write-Host "  ─────────────────────────────────────────────"
Write-Host ""
