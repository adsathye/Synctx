#!/usr/bin/env node
'use strict';

/**
 * Synctx — Auto-Setup (runs on sessionStart)
 *
 * Performs silent first-time setup if not already configured:
 *   1. Checks prerequisites (git, gh, gitleaks)
 *   2. Creates or clones the sync repository with default name
 *   3. Pulls existing data if repo exists
 *
 * Runs non-interactively with defaults. For custom repo name,
 * run: /synctx setup
 *
 * @license MIT
 */

const { execSync, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const isWin = os.platform() === 'win32';
const CONFIG_FILE = path.join(os.homedir(), '.synctx', '.config.json');
const DEFAULT_REPO = '.synctx';
const GIT_HOST = process.env.SYNCTX_GIT_HOST || 'github.com';

// PATH augmentation — Copilot CLI may run hooks with a stripped-down PATH
if (isWin) {
  const localAppData = process.env.LOCALAPPDATA || '';
  const extraPaths = [
    path.join(localAppData, 'Microsoft', 'WindowsApps'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'gitleaks'),
    path.join(localAppData, 'Programs', 'GitHub CLI'),
  ];

  // Scan winget package directories for installed tools
  const wingetPkgs = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetPkgs)) {
    try {
      for (const pkg of fs.readdirSync(wingetPkgs)) {
        const pkgDir = path.join(wingetPkgs, pkg);
        if (fs.statSync(pkgDir).isDirectory()) {
          extraPaths.push(pkgDir);
        }
      }
    } catch { /* best-effort */ }
  }

  for (const p of extraPaths) {
    if (fs.existsSync(p) && !process.env.PATH.includes(p)) {
      process.env.PATH += ';' + p;
    }
  }
} else {
  const home = os.homedir();
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/snap/bin',
    path.join(home, '.linuxbrew', 'bin'),
    '/home/linuxbrew/.linuxbrew/bin',
  ];

  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  const nvmVersions = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(nvmVersions)) {
    try {
      const versions = fs.readdirSync(nvmVersions)
        .filter(v => v.startsWith('v'))
        .sort()
        .reverse();
      if (versions.length > 0) {
        extraPaths.push(path.join(nvmVersions, versions[0], 'bin'));
      }
    } catch { /* best-effort */ }
  }

  for (const p of extraPaths) {
    if (fs.existsSync(p) && !process.env.PATH.includes(p)) {
      process.env.PATH += ':' + p;
    }
  }
}

// Exit silently if already set up — but clean stale locks first
try {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (config.repoName) {
    // Clean stale lock if the owning process is dead
    const lockFile = path.join(os.homedir(), '.synctx', '.sync_lock');
    try {
      if (fs.existsSync(lockFile)) {
        const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        try { process.kill(lock.pid, 0); } catch { fs.unlinkSync(lockFile); }
      }
    } catch { /* best-effort */ }
    process.exit(0);
  }
} catch { /* not configured yet */ }

// Check prerequisites silently
function cmdExists(cmd) {
  try {
    execSync(`${isWin ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

if (!cmdExists('git') || !cmdExists('gh') || !cmdExists('gitleaks')) {
  process.exit(0);
}

try {
  execSync('gh auth status', { stdio: 'ignore', windowsHide: true });
} catch {
  process.exit(0);
}

// Save default config
const configDir = path.dirname(CONFIG_FILE);
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ repoName: DEFAULT_REPO }, null, 2) + '\n');

// Bootstrap: create or clone repo
const syncDir = path.join(os.homedir(), '.synctx');

if (fs.existsSync(path.join(syncDir, '.git'))) {
  try {
    execFileSync('git', ['pull', 'origin', 'main', '--no-edit'], {
      cwd: syncDir, stdio: 'ignore', windowsHide: true,
    });
  } catch { /* ignore */ }
  process.exit(0);
}

// Helper: set or add remote origin
function setRemote(dir, url) {
  try {
    execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: dir, stdio: 'ignore', windowsHide: true });
  } catch {
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir, stdio: 'ignore', windowsHide: true });
  }
}

// Wrap bootstrap in try-catch so a network failure during sessionStart
// doesn't cause a noisy unhandled exception on every session.
try {
  // Get GitHub user (use execFileSync for safety)
  const user = execSync('gh api user --jq .login', { encoding: 'utf8', windowsHide: true }).trim();
  const repoUrl = `https://${GIT_HOST}/${user}/${DEFAULT_REPO}.git`;

  // Check if repo exists on GitHub
  let repoExists = false;
  try {
    execFileSync('gh', ['repo', 'view', `${user}/${DEFAULT_REPO}`, '--json', 'name'], {
      stdio: 'ignore', windowsHide: true,
    });
    repoExists = true;
  } catch { /* doesn't exist */ }

  if (repoExists) {
    try {
      if (!fs.existsSync(syncDir)) fs.mkdirSync(syncDir, { recursive: true });
      execFileSync('git', ['init'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'core.safecrlf', 'false'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      setRemote(syncDir, repoUrl);
      execFileSync('git', ['fetch', 'origin'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      try {
        execFileSync('git', ['checkout', '-b', 'main', 'origin/main'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      } catch {
        execFileSync('git', ['checkout', '-b', 'main'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      }
    } catch { /* will retry on push */ }
  } else {
    try {
      if (!fs.existsSync(syncDir)) fs.mkdirSync(syncDir, { recursive: true });
      execFileSync('gh', ['repo', 'create', DEFAULT_REPO, '--private'], { stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['init'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['config', 'core.safecrlf', 'false'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
      setRemote(syncDir, repoUrl);
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: syncDir, stdio: 'ignore', windowsHide: true });
    } catch { /* will retry on push */ }
  }
} catch {
  // Network or gh CLI failure — will retry on next session start
  process.exit(0);
}
