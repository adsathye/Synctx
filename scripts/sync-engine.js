#!/usr/bin/env node
'use strict';

/**
 * Synctx — Sync Engine (Entry Point)
 *
 * A secure, cross-device session synchronizer for GitHub Copilot CLI and
 * Claude Code. Backs up AI conversation state to a private Git repository
 * with built-in Gitleaks secret scanning.
 *
 * Commands:
 *   push      — Stage, scan, and sync session state to the remote sync repo.
 *   restore   — Pull the latest data from the remote repository.
 *   clean     — Remove synced session data from sync directory.
 *   status    — Show configuration and prerequisites.
 *
 * Architecture:
 *   scripts/lib/config.js       — Configuration & CLI path mappings
 *   scripts/lib/logger.js       — Audit logger
 *   scripts/lib/file-manager.js — Recursive file operations
 *   scripts/lib/security.js     — Gitleaks secret scanner
 *   scripts/lib/git-manager.js  — Git lifecycle (bootstrap, sync, restore)
 *   scripts/lib/lock.js         — Concurrency lock
 *
 * @license MIT
 */

const { execSync, execFileSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─────────────────────────────────────────────────────────────────────────────
// PATH Augmentation
// Copilot CLI may run hooks with a stripped-down PATH.
// ─────────────────────────────────────────────────────────────────────────────

if (os.platform() === 'win32') {
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
  // macOS / Linux PATH Augmentation
  // Copilot CLI may run hooks with a stripped-down PATH that excludes
  // Homebrew, nvm, snap, and other common tool locations.
  const home = os.homedir();
  const extraPaths = [
    '/opt/homebrew/bin',            // Homebrew on Apple Silicon
    '/opt/homebrew/sbin',
    '/usr/local/bin',               // Homebrew on Intel Mac / manual installs
    '/usr/local/sbin',
    '/snap/bin',                    // Linux snap packages
    path.join(home, '.linuxbrew', 'bin'),          // Homebrew on Linux (user)
    '/home/linuxbrew/.linuxbrew/bin',              // Homebrew on Linux (system)
  ];

  // nvm: resolve the latest installed Node.js version
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

const { VERSION, CONFIG, getCLIMappings, reloadConfig } = require('./lib/config');
const Logger = require('./lib/logger');
const FileManager = require('./lib/file-manager');
const SecurityScanner = require('./lib/security');
const GitManager = require('./lib/git-manager');
const Lock = require('./lib/lock');

// ─────────────────────────────────────────────────────────────────────────────
// First-Run Setup
// ─────────────────────────────────────────────────────────────────────────────

const USER_CONFIG_FILE = path.join(os.homedir(), '.synctx', '.config.json');

/** Check if first-run setup has been completed. */
function isSetupDone() {
  try {
    const config = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
    return Boolean(config.repoName);
  } catch {
    return false;
  }
}

/** Prompt user for input. */
function prompt(question, defaultValue) {
  return new Promise((resolve) => {
    let input = process.stdin;
    if (!process.stdin.isTTY) {
      try {
        input = fs.createReadStream('/dev/tty');
      } catch {
        resolve(defaultValue);
        return;
      }
    }
    const rl = readline.createInterface({ input, output: process.stdout });
    rl.question(`${question} [${defaultValue}]: `, (answer) => {
      rl.close();
      if (input !== process.stdin) {
        try { input.close(); } catch { /* best-effort */ }
      }
      resolve(answer.trim() || defaultValue);
    });
  });
}

/** Save user config. */
function saveUserConfig(config) {
  const dir = path.dirname(USER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Interactive first-run setup. Prompts for repo name, checks if the repo
 * exists on GitHub, and clones or creates it.
 */
async function firstRunSetup() {
  if (isSetupDone()) return;

  const { printBanner } = require('./cli-art');
  printBanner();

  // Check prerequisites
  const missing = [];
  for (const cmd of ['git', 'gh', 'gitleaks']) {
    try {
      execSync(`${os.platform() === 'win32' ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore', windowsHide: true });
    } catch {
      missing.push(cmd);
    }
  }
  if (missing.length > 0) {
    console.log(`  [error] Missing prerequisites: ${missing.join(', ')}`);
    console.log('  Install them and try again.\n');
    throw new Error(`Missing prerequisites: ${missing.join(', ')}`);
  }

  // Check GitHub auth
  try {
    execSync('gh auth status', { stdio: 'ignore', windowsHide: true });
  } catch {
    console.log('  [error] GitHub CLI is not authenticated. Run: gh auth login\n');
    throw new Error('GitHub CLI not authenticated');
  }

  const user = execSync('gh api user --jq .login', { encoding: 'utf8', windowsHide: true }).trim();
  console.log(`  [ok] Authenticated as: ${user}\n`);

  // Check for existing config
  let repoName;
  try {
    const existingConfig = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
    if (existingConfig.repoName) {
      repoName = existingConfig.repoName;
      console.log(`  [ok] Existing sync repository found: ${repoName}`);
      console.log(`     To change, run: synctx uninstall && synctx setup\n`);
    }
  } catch { /* no config yet */ }

  if (!repoName) {
    // First install — prompt for repo name
    console.log('  The plugin stores session data in a private GitHub repository.');
    console.log('  Press Enter to accept the default name, or type a custom name.\n');
    repoName = await prompt('  Repository name', '.synctx');
  }

  // Save config so engine uses this repo name
  saveUserConfig({ repoName });
  process.env.SYNCTX_REPO_NAME = repoName;
  reloadConfig();

  // Check if repo already exists on GitHub
  let repoExists = false;
  try {
    execFileSync('gh', ['repo', 'view', `${user}/${repoName}`, '--json', 'name'], {
      stdio: 'ignore', windowsHide: true,
    });
    repoExists = true;
  } catch {
    repoExists = false;
  }

  if (repoExists && !fs.existsSync(path.join(CONFIG.syncDir, '.git'))) {
    console.log(`\n  [info] Found existing repo '${repoName}' on GitHub. Syncing...`);
    try {
      if (!fs.existsSync(CONFIG.syncDir)) fs.mkdirSync(CONFIG.syncDir, { recursive: true });
      execFileSync('git', ['init'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['remote', 'add', 'origin', `https://${CONFIG.gitHost}/${user}/${repoName}.git`], {
        cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
      });
      execFileSync('git', ['fetch', 'origin'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
      try {
        execFileSync('git', ['checkout', '-b', CONFIG.branch, `origin/${CONFIG.branch}`], {
          cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
        });
      } catch {
        execFileSync('git', ['checkout', '-b', CONFIG.branch], {
          cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
        });
      }
      console.log('  [ok] Synced Existing data to local machine.\n');
    } catch {
      console.log('  [warn] Sync failed — will retry on first push.\n');
    }
  } else if (!repoExists) {
    console.log(`\n  [info] Repository '${repoName}' will be created on first sync.\n`);
  } else {
    console.log(`\n  [ok] Local repository already set up.\n`);
  }

  console.log('  Setup complete! Sessions will sync automatically.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Change Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if any CLI source directory has been modified since the last sync.
 * Compares directory mtimes against the saved .last_sync timestamp.
 * Returns true on first run or if any source is newer.
 *
 * @returns {boolean}
 */
function hasSourcesChangedSinceLastSync() {
  let lastSync = 0;
  try {
    if (fs.existsSync(CONFIG.lastSyncFile)) {
      const ts = fs.readFileSync(CONFIG.lastSyncFile, 'utf8').trim();
      lastSync = new Date(ts).getTime();
    }
  } catch { /* first run */ }

  if (lastSync === 0) return true; // Never synced before

  for (const cli of getCLIMappings()) {
    for (const source of cli.sources) {
      if (!fs.existsSync(source)) continue;
      try {
        const stat = fs.statSync(source);
        if (stat.mtimeMs > lastSync) return true;
        // Check session dirs and their immediate files for mtime changes
        for (const child of fs.readdirSync(source)) {
          const childPath = path.join(source, child);
          const childStat = fs.statSync(childPath);
          if (childStat.mtimeMs > lastSync) return true;
          // Check files inside session dirs (e.g., events.jsonl updates)
          if (childStat.isDirectory()) {
            try {
              for (const file of fs.readdirSync(childPath)) {
                const fileStat = fs.statSync(path.join(childPath, file));
                if (fileStat.mtimeMs > lastSync) return true;
              }
            } catch { /* skip unreadable */ }
          }
        }
      } catch { continue; }
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon (Push)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the push workflow as a detached daemon.
 *
 * On first invocation (no --daemon flag), the process:
 *   1. Acquires the lock (exits if locked).
 *   2. Spawns a detached child with the --daemon flag.
 *   3. Exits immediately so the caller is not blocked.
 *
 * The detached child (--daemon) runs the full pipeline:
 *   bootstrap → stage → scan → sync → release lock.
 */
function runDaemon() {
  const isDaemon = process.argv[3] === '--daemon';

  if (!isDaemon) {
    if (!Lock.acquire()) {
      process.exit(0); // Another sync is running
    }

    try {
      const child = spawn(
        process.execPath,
        [__filename, 'push', '--daemon'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
    } catch {
      Lock.release();
    }

    process.exit(0);
  }

  // Register cleanup handlers for all platforms
  const cleanup = () => { Lock.release(); process.exit(1); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  // Windows: handle Ctrl+C and process exit
  if (os.platform() === 'win32') {
    process.on('SIGHUP', cleanup);
  }
  process.on('exit', () => { Lock.release(); });

  try {
    Lock.refresh(); // Claim lock with daemon PID before any work

    GitManager.bootstrap();
    Lock.refresh();

    // Always pull latest from remote (ensures staging has other machines' data)
    try {
      execFileSync('git', ['stash'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
    } catch { /* nothing to stash */ }
    try {
      execFileSync('git', ['fetch', 'origin', CONFIG.branch], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
      try {
        execFileSync('git', ['merge', `origin/${CONFIG.branch}`, '--allow-unrelated-histories', '-X', 'theirs', '--no-edit'], {
          cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
        });
      } catch {
        try {
          execFileSync('git', ['checkout', '--theirs', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
          execFileSync('git', ['add', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
          execFileSync('git', ['commit', '--no-edit', '-m', 'Merge remote'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
        } catch { /* best effort */ }
      }
    } catch { /* offline or empty repo */ }
    try {
      execFileSync('git', ['stash', 'pop'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
    } catch { /* no stash */ }
    Lock.refresh();

    // Always stage and push — delta copy skips unchanged files efficiently.
    // Removing the change detection check ensures no sync is ever missed,
    // especially on sessionEnd when the CLI writes final events after hooks fire.
    const ignoreContent = SecurityScanner.preserveIgnoreFile();
    const result = FileManager.stageFiles();
    SecurityScanner.restoreIgnoreFile(ignoreContent);
    const mb = (result.bytes / (1024 * 1024)).toFixed(2);
    Logger.log('INFO', `Staged ${result.files} files (${mb} MB) from ${result.sources} source(s).`);
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        Logger.log('ERROR', `Stage error: ${err}`);
      }
    }
    Lock.refresh();

    if (result.files > 0) {
      SecurityScanner.check();
    }

    Lock.refresh();
    GitManager.sync();
  } catch (error) {
    Logger.log('ERROR', `Daemon failed: ${error.message}`);
  } finally {
    Lock.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-Run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate configuration and paths without touching Git or the network.
 */
function dryRun() {
  const { c, progress } = require('./lib/format');
  console.log(`\n${c.bold}${c.teal}  Synctx v${VERSION} — Status${c.reset}\n`);

  console.log(`  ${c.dim}Version${c.reset}       ${VERSION}`);
  console.log(`  ${c.dim}Platform${c.reset}      ${os.platform()}`);
  console.log(`  ${c.dim}Home${c.reset}          ${os.homedir()}`);
  console.log(`  ${c.dim}Sync dir${c.reset}      ${CONFIG.syncDir}`);
  console.log(`  ${c.dim}Repo name${c.reset}     ${CONFIG.repoName}`);
  console.log('');

  // Last sync time
  try {
    if (fs.existsSync(CONFIG.lastSyncFile)) {
      const ts = fs.readFileSync(CONFIG.lastSyncFile, 'utf8').trim();
      const age = Date.now() - new Date(ts).getTime();
      const mins = Math.floor(age / 60000);
      const timeAgo = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
      console.log(`Last sync:     ${ts} (${timeAgo})`);
    } else {
      console.log('Last sync:     never');
    }
  } catch {
    console.log('Last sync:     unknown');
  }
  console.log('');

  // CLI source dirs
  for (const cli of getCLIMappings()) {
    console.log(`CLI: ${cli.name}`);
    for (const src of cli.sources) {
      if (fs.existsSync(src)) {
        console.log(`  [ok] ${src}`);
      } else {
        console.log(`  ${c.dim}[--] ${src} (not found)${c.reset}`);
      }
    }
  }
  console.log('');

  // Repo sync status
  console.log('Sync status:');
  try {
    const gitDir = path.join(CONFIG.syncDir, '.git');
    if (fs.existsSync(gitDir)) {
      // Get local session count
      let localSessions = 0;
      for (const cli of getCLIMappings()) {
        for (const source of cli.sources) {
          const folderName = path.basename(source);
          const stagedDir = path.join(CONFIG.syncDir, cli.name, folderName);
          if (fs.existsSync(stagedDir)) {
            try {
              localSessions += fs.readdirSync(stagedDir).length;
            } catch { /* skip */ }
          }
        }
      }
      console.log(`  [info] Local sessions: ${localSessions}`);

      // Check remote status
      const pRemote = progress('Remote');
      pRemote.update('Fetching remote status...');
      try {
        execFileSync('git', ['fetch', 'origin', CONFIG.branch], {
          cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
        });
        pRemote.done('Remote status fetched');

        const localHead = execSync('git rev-parse HEAD', {
          cwd: CONFIG.syncDir, encoding: 'utf8', windowsHide: true,
        }).trim();
        const remoteHead = execSync(`git rev-parse origin/${CONFIG.branch}`, {
          cwd: CONFIG.syncDir, encoding: 'utf8', windowsHide: true,
        }).trim();

        if (localHead === remoteHead) {
          console.log('  [ok] In sync with remote');
        } else {
          // Count how many commits behind/ahead
          const behind = execSync(`git rev-list HEAD..origin/${CONFIG.branch} --count`, {
            cwd: CONFIG.syncDir, encoding: 'utf8', windowsHide: true,
          }).trim();
          const ahead = execSync(`git rev-list origin/${CONFIG.branch}..HEAD --count`, {
            cwd: CONFIG.syncDir, encoding: 'utf8', windowsHide: true,
          }).trim();
          if (parseInt(behind) > 0) console.log(`  [behind] ${behind} commit(s) behind remote`);
          if (parseInt(ahead) > 0) console.log(`  [ahead] ${ahead} commit(s) ahead of remote`);
        }

        // Check for unsynced local changes
        const status = execSync('git status --porcelain', {
          cwd: CONFIG.syncDir, encoding: 'utf8', windowsHide: true,
        }).trim();
        if (status) {
          const unsynced = status.split('\n').length;
          console.log(`  [warn] ${unsynced} unsynced local change(s)`);
        }
      } catch {
        pRemote.skip('Could not check remote status');
      }

      // Remote URL — show as clickable link
      try {
        const remote = execSync('git remote get-url origin', {
          cwd: CONFIG.syncDir, encoding: 'utf8', windowsHide: true,
        }).trim();
        const repoUrl = remote.replace(/\.git$/, '');
        console.log(`  ${c.dim}Repo${c.reset}     ${repoUrl}`);
      } catch { /* no remote */ }
    } else {
      console.log('  [error] Not initialized — run synctx sync or synctx setup');
    }
  } catch { /* skip */ }
  console.log('');

  // Prerequisites
  const checks = [
    { name: 'Node.js', cmd: 'node --version' },
    { name: 'Git', cmd: 'git --version' },
    { name: 'GitHub CLI (gh)', cmd: 'gh --version' },
    { name: 'Gitleaks', cmd: 'gitleaks version' },
  ];

  console.log('Prerequisites:');
  for (const { name, cmd } of checks) {
    try {
      const ver = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim().split('\n')[0];
      console.log(`  [ok] ${name}: ${ver}`);
    } catch {
      console.log(`  [error] ${name}: NOT FOUND`);
    }
  }

  console.log('\n[ok] Status check complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse --key value pairs from process.argv.
 *
 * @returns {{ action: string, args: Record<string, string> }}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const action = argv[0] || 'push';
  const args = {};

  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = 'true';
    } else if (!args._positional) {
      args._positional = argv[i];
    } else if (!args._extra) {
      args._extra = argv[i];
    }
  }

  return { action, args };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull latest data from remote before any read/write operation.
 * Handles uncommitted changes, diverged histories, and merge conflicts.
 */
function pullLatest() {
  const { progress } = require('./lib/format');
  const p = progress('Remote');
  p.update('Pulling from remote...');
  try {
    GitManager.bootstrap();

    // Stash uncommitted changes
    try {
      execFileSync('git', ['add', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['stash'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
    } catch { /* nothing to stash */ }

    // Fetch + merge
    try {
      execFileSync('git', ['fetch', 'origin', CONFIG.branch], {
        cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
      });
      try {
        execFileSync('git', ['merge', `origin/${CONFIG.branch}`, '--allow-unrelated-histories', '-X', 'theirs', '--no-edit'], {
          cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
        });
      } catch {
        // Merge conflict — accept remote
        try {
          execFileSync('git', ['checkout', '--theirs', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
          execFileSync('git', ['add', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
          execFileSync('git', ['commit', '--no-edit', '-m', 'Merge remote changes'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
        } catch { /* best effort */ }
      }
    } catch { /* offline or empty repo */ }

    // Pop stash
    try {
      execFileSync('git', ['stash', 'pop'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
    } catch { /* no stash or conflicts */ }

    p.done('Up to date');
  } catch {
    p.skip('Pull skipped (offline or empty repo)');
  }
}

const COMMANDS = {
  push: () => runDaemon(),

  sync: () => {
    const { c, progress } = require('./lib/format');
    try {
      console.log(`\n${c.bold}${c.teal}  Synctx — Sync${c.reset}\n`);

      const p = progress('Sync');

      p.update('Bootstrapping...');
      GitManager.bootstrap();

      // Stash
      try {
        execFileSync('git', ['add', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
        execFileSync('git', ['stash'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
      } catch { /* nothing to stash */ }

      // Pull
      p.update('Pulling from remote...');
      try {
        execFileSync('git', ['fetch', 'origin', CONFIG.branch], {
          cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
        });
        try {
          execFileSync('git', ['merge', `origin/${CONFIG.branch}`, '--allow-unrelated-histories', '-X', 'theirs', '--no-edit'], {
            cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
          });
        } catch {
          try {
            execFileSync('git', ['checkout', '--theirs', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
            execFileSync('git', ['add', '.'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
            execFileSync('git', ['commit', '--no-edit', '-m', 'Merge remote changes'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
          } catch { /* best effort */ }
        }
        p.done('Pulled from remote');
      } catch {
        p.skip('Pull skipped (remote may be empty)');
      }

      // Pop stash
      try {
        execFileSync('git', ['stash', 'pop'], { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
      } catch { /* no stash */ }

      // Stage
      const ps = progress('Stage');
      ps.update('Copying session files...');
      const ignoreContent = SecurityScanner.preserveIgnoreFile();
      const result = FileManager.stageFiles();
      SecurityScanner.restoreIgnoreFile(ignoreContent);
      const mb = (result.bytes / (1024 * 1024)).toFixed(2);
      ps.done(`Staged ${result.files} files (${mb} MB)`);

      // Scan
      if (result.files > 0) {
        const sc = progress('Security');
        sc.update('Scanning for secrets...');
        SecurityScanner.check();
        sc.done('Security scan passed');
      }

      // Push
      const pp = progress('Push');
      pp.update('Pushing to remote...');
      GitManager.sync();
      pp.done('Pushed to remote');

      console.log(`\n  ${c.green}${c.bold}✓ Sync complete${c.reset}\n`);
    } catch (error) {
      const { c: co } = require('./lib/format');
      Logger.log('ERROR', `Sync failed: ${error.message}`);
      console.error(`\n  ${co.red}✗ Sync failed:${co.reset} ${error.message}\n`);
    }
  },

  restore: (args) => {
    const { c, progress } = require('./lib/format');
    try {
      pullLatest();

      const target = args._positional || args.session || args.tag;
      if (target) {
        const Tags = require('./lib/tags');
        const ListCmd = require('./lib/commands/list');

        let sessionId = target;
        let cli = args.cli;
        const resolved = Tags.resolve(target);
        if (resolved) {
          sessionId = resolved.sessionId;
          cli = resolved.cli;
        }

        const pr = progress('Session');
        pr.update(`Finding ${target}...`);
        const session = ListCmd.findSession(sessionId);
        if (!session) {
          const Tombstones = require('./lib/tombstones');
          const tombstones = Tombstones.readAll();
          const tombstoned = Object.keys(tombstones).find(k => k === sessionId || k.startsWith(sessionId));
          if (tombstoned) {
            pr.fail(`Session "${target}" has been deleted and cannot be restored`);
          } else {
            pr.fail(`Session "${target}" not found`);
          }
          return;
        }

        const home = os.homedir();
        let destDir;
        if (session.cli === 'github-copilot') {
          destDir = path.join(home, '.copilot', 'session-state', session.id);
        } else if (session.cli === 'claude') {
          destDir = path.join(home, '.claude', 'projects', session.id);
        }

        if (destDir) {
          pr.update('Copying session files...');
          const copyRecursive = (src, dest) => {
            if (!fs.existsSync(src)) return;
            const stat = fs.statSync(src);
            if (stat.isDirectory()) {
              fs.mkdirSync(dest, { recursive: true });
              for (const child of fs.readdirSync(src)) {
                copyRecursive(path.join(src, child), path.join(dest, child));
              }
            } else {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.copyFileSync(src, dest);
            }
          };
          copyRecursive(session.path, destDir);

          // Fix cross-platform paths in workspace.yaml
          const wsFile = path.join(destDir, 'workspace.yaml');
          let sessionCwd = process.cwd();
          if (fs.existsSync(wsFile)) {
            try {
              let ws = fs.readFileSync(wsFile, 'utf8');
              const cwdMatch = ws.match(/^cwd:\s*(.+)$/m);
              if (cwdMatch) {
                const origCwd = cwdMatch[1].trim();
                if (!fs.existsSync(origCwd)) {
                  ws = ws.replace(/^cwd:\s*.+$/m, `cwd: ${sessionCwd}`);
                  ws = ws.replace(/^git_root:\s*.+$/m, `git_root: ${sessionCwd}`);
                  fs.writeFileSync(wsFile, ws);
                } else {
                  sessionCwd = origCwd;
                }
              }
            } catch { /* best-effort */ }
          }

          // Ensure events.jsonl starts with session.start (required for /resume)
          const evFile = path.join(destDir, 'events.jsonl');
          if (fs.existsSync(evFile)) {
            try {
              const firstLine = fs.readFileSync(evFile, 'utf8').split('\n')[0];
              const firstEvent = JSON.parse(firstLine);
              if (firstEvent.type !== 'session.start') {
                const crypto = require('crypto');
                const startId = crypto.randomUUID();
                const now = new Date().toISOString();
                const copilotVer = (() => { try { return execSync('copilot --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }).trim().split('\n')[0].replace(/[^0-9.]/g, ''); } catch { return '1.0.0'; } })();

                const sessionStart = JSON.stringify({
                  type: 'session.start',
                  data: {
                    sessionId: session.id,
                    version: 1,
                    producer: 'copilot-agent',
                    copilotVersion: copilotVer,
                    startTime: now,
                    context: { cwd: sessionCwd, gitRoot: sessionCwd },
                  },
                  id: startId,
                  timestamp: now,
                  parentId: null,
                });

                const sessionInfo = JSON.stringify({
                  type: 'session.info',
                  data: { infoType: 'restored', message: `Session restored by Synctx from another device.` },
                  id: crypto.randomUUID(),
                  timestamp: now,
                  parentId: startId,
                });

                const content = fs.readFileSync(evFile, 'utf8');
                fs.writeFileSync(evFile, sessionStart + '\n' + sessionInfo + '\n' + content);
              }
            } catch { /* best-effort */ }
          }

          const tagInfo = resolved ? ` ${c.orange}(${resolved.tag})${c.reset}` : '';
          pr.done(`Restored ${session.id.slice(0, 8)}...${tagInfo}`);

          if (session.cli === 'github-copilot') {
            console.log(`\n  ${c.dim}Launching Copilot CLI...${c.reset}\n`);
            try {
              execSync(`copilot --resume ${session.id}`, { stdio: 'inherit', windowsHide: false });
            } catch {
              const label = resolved ? resolved.tag : session.id;
              console.log(`  ${c.dim}Could not auto-launch. You can:${c.reset}`);
              console.log(`  ${c.bold}${c.teal}copilot --resume ${session.id}${c.reset}`);
              console.log(`  ${c.dim}or open Copilot CLI and ask:${c.reset}`);
              console.log(`  ${c.bold}${c.teal}"restore session ${label}"${c.reset}\n`);
            }
          }
        }
      }
    } catch (error) {
      Logger.log('ERROR', `Restore failed: ${error.message}`);
      const { c: co } = require('./lib/format');
      console.error(`  ${co.red}✗ Restore failed:${co.reset} ${error.message}`);
    }
  },

  clean: async () => {
    const { progress } = require('./lib/format');
    pullLatest();
    try {
      const { doubleConfirm } = require('./lib/confirm');
      const confirmed = await doubleConfirm(
        'This will delete all synced session data from the local sync directory\n' +
        '  (~/.synctx/) AND push the cleanup to the remote sync repo.\n' +
        '  Your original CLI session directories will NOT be modified.\n' +
        '  All cleaned sessions will be tombstoned — they will NOT be\n' +
        '  re-synced from any machine. Any tags will be released.',
      );
      if (!confirmed) return;

      Logger.log('USER_ACTION', 'User requested staging directory cleanup.');

      // Collect all sessions before cleaning, then tombstone them
      const ListCmd = require('./lib/commands/list');
      const { scanSessions } = ListCmd;
      const Tombstones = require('./lib/tombstones');
      const Tags = require('./lib/tags');
      const allSessions = [];

      for (const cli of getCLIMappings()) {
        for (const source of cli.sources) {
          const folderName = path.basename(source);
          const stagedDir = path.join(CONFIG.syncDir, cli.name, folderName);
          for (const s of scanSessions(stagedDir)) {
            allSessions.push({ sessionId: s.name, cli: cli.name });
          }
        }
      }

      const pClean = progress('Clean');
      pClean.update('Removing synced data...');
      FileManager.cleanStaging();

      // Release ALL tags (clean is a full wipe, not just scanned sessions)
      const allTags = Tags.readTags();
      const tagCount = Object.keys(allTags).length;
      if (tagCount > 0) {
        for (const tag of Object.keys(allTags)) {
          Tags.remove(tag);
        }
      }

      if (allSessions.length > 0) {
        Tombstones.recordMany(allSessions, 'clean');
        pClean.done(`Removed ${allSessions.length} session(s)${tagCount > 0 ? `, released ${tagCount} tag(s)` : ''}`);
      } else {
        pClean.done(`Local data removed${tagCount > 0 ? `, released ${tagCount} tag(s)` : ''}`);
      }

      const pSync = progress('Sync');
      pSync.update('Pushing cleanup to remote...');
      try {
        GitManager.commitAndPush('Clean: staging area cleared by user');
        pSync.done('Cleanup synced to remote');
      } catch {
        pSync.skip('Cleaned locally (remote sync failed)');
      }

      console.log('[ok] Staging directory has been cleaned.');
    } catch (error) {
      Logger.log('ERROR', `Clean failed: ${error.message}`);
      console.error(`[warn] Clean failed: ${error.message}`);
    }
  },

  list: (args) => {
    pullLatest();
    const ListCmd = require('./lib/commands/list');
    ListCmd.execute({ cli: args.cli || args._positional });
  },

  'list-copilot': () => {
    pullLatest();
    const ListCmd = require('./lib/commands/list');
    ListCmd.execute({ cli: 'copilot' });
  },

  'list-claude': () => {
    pullLatest();
    const ListCmd = require('./lib/commands/list');
    ListCmd.execute({ cli: 'claude' });
  },

  prune: async (args) => {
    pullLatest();
    const PruneCmd = require('./lib/commands/prune');
    const days = parseInt(args.days || args._positional || '90', 10);
    await PruneCmd.execute({ days, cli: args.cli });
  },

  delete: async (args) => {
    pullLatest();
    const DeleteCmd = require('./lib/commands/delete');
    const sessionId = args._positional || args.session;
    await DeleteCmd.execute({ sessionId, cli: args.cli });
  },

  help: () => showHelp(),
  '-help': () => showHelp(),
  '--help': () => showHelp(),
  '-h': () => showHelp(),

  uninstall: () => {
    require('./uninstall');
  },

  setup: () => {
    require('./postinstall');
  },

  tag: (args) => {
    const { progress } = require('./lib/format');
    pullLatest();
    const Tags = require('./lib/tags');
    const sessionId = args._positional;
    const tagName = args.tag || args._extra;

    if (!sessionId || !tagName) {
      console.log('Usage: node sync-engine.js tag <session-id> --tag <tag-name>');
      console.log('   or: node sync-engine.js tag <session-id> <tag-name>');
      return;
    }

    // Find which CLI this session belongs to
    const ListCmd = require('./lib/commands/list');
    const session = ListCmd.findSession(sessionId);
    if (!session) {
      const Tombstones = require('./lib/tombstones');
      const tombstones = Tombstones.readAll();
      const tombstoned = Object.keys(tombstones).find(k => k === sessionId || k.startsWith(sessionId));
      if (tombstoned) {
        console.error(`[error] Session "${sessionId}" has been deleted and cannot be tagged.`);
      } else {
        console.error(`[error] Session "${sessionId}" not found.`);
      }
      return;
    }

    const result = Tags.assign(tagName, session.id, session.cli);
    if (result.success) {
      if (result.warning) {
        console.log(`[warn] ${result.warning}`);
      }
      const assigned = result.assignedTag || tagName.toLowerCase();
      console.log(`[ok] Tagged "${session.id}" as "${assigned}"`);
      const pSync = progress('Sync');
      pSync.update('Syncing tag...');
      try {
        GitManager.commitAndPush(`Tag: ${assigned} → ${session.id}`);
        pSync.done('Tag synced');
      } catch {
        pSync.skip('Tag saved locally (sync failed)');
      }
    } else {
      console.error(`[error] ${result.error}`);
    }
  },

  untag: (args) => {
    const { progress } = require('./lib/format');
    const Tags = require('./lib/tags');
    const tagName = args._positional || args.tag;

    if (!tagName) {
      console.log('Usage: synctx untag <tag-name>');
      return;
    }

    const result = Tags.remove(tagName);
    if (result.success) {
      console.log(`[ok] Tag "${tagName.toLowerCase()}" removed.`);
      const pSync = progress('Sync');
      pSync.update('Syncing...');
      try {
        GitManager.commitAndPush(`Untag: ${tagName.toLowerCase()}`);
        pSync.done('Change synced');
      } catch {
        pSync.skip('Removed locally (sync failed)');
      }
    } else {
      console.error(`[error] ${result.error}`);
    }
  },

  tags: () => {
    pullLatest();
    const Tags = require('./lib/tags');
    const allTags = Tags.readTags();
    const entries = Object.entries(allTags);

    if (entries.length === 0) {
      console.log('No tags found. Use: node sync-engine.js tag <session-id> <tag-name>');
      return;
    }

    console.log(`\n  # Session Tags (${entries.length})\n`);
    for (const [tag, entry] of entries) {
      const cli = entry.cli === 'github-copilot' ? 'Copilot' : 'Claude';
      console.log(`  ${tag}  →  ${entry.sessionId}  (${cli})`);
    }
    console.log('');
  },

  status: () => dryRun(),

  version: () => console.log(`synctx v${VERSION}`),
  '--version': () => console.log(`synctx v${VERSION}`),
  '-v': () => console.log(`synctx v${VERSION}`),
};

function showHelp() {
  console.log(`
  Synctx v${VERSION}
  Secure AI CLI session synchronizer
  for GitHub Copilot CLI and Claude Code.

Usage: synctx <command> [options]

Commands:
  sync                                        Full sync — pull remote + push local sessions
  push                                        Push local sessions to remote (background daemon)
  restore [<tag|id|current>]                  Restore a session and launch Copilot CLI with it
  list [--cli copilot|claude]                 List all synced sessions (pulls from remote first)
  list-copilot                                List Copilot sessions only
  list-claude                                 List Claude sessions only
  delete <tag|id|current> [--cli copilot|claude]  Delete a specific session
  prune [--days N] [--cli copilot|claude]     Delete sessions older than N days (default: 90)
  clean                                       Wipe all synced data from local sync directory
  tag <tag|id|current> <tag-name>             Assign a friendly tag to a session
  untag <tag-name>                            Remove a tag
  tags                                        List all session tags
  status                                      Show sync health, session count, and prerequisites
  setup                                       Run first-time setup wizard
  uninstall                                   Fully remove Synctx and all data
  version                                     Show version
  help                                        Show this help

Options:
  --cli <name>    Filter by CLI: copilot, claude, or all (default: all)
  --days <N>      Retention period in days for prune (default: 90)

Session identifiers:
  <tag>           Friendly tag name (e.g., auth-refactor)
  <id>            Full or partial session UUID (e.g., e0e9f4b8)
  current         The most recently active Copilot session

Examples:
  synctx sync                             # Full sync (pull + push)
  synctx list                             # List all sessions
  synctx list --cli copilot               # List Copilot sessions only
  synctx tag current my-feature           # Tag the current session
  synctx tag e0e9f4b8 auth-work           # Tag by session ID
  synctx restore my-feature               # Restore and launch by tag
  synctx restore current                  # Restore the latest session
  synctx delete auth-work                 # Delete by tag
  synctx prune --days 60                  # Remove sessions older than 60 days
  synctx tags                             # Show all tags
  synctx status                           # Check sync health

Environment Variables:
  SYNCTX_GIT_HOST      Git host (default: github.com)
  SYNCTX_SYNC_DIR      Sync directory override (default: ~/.synctx)
  SYNCTX_REPO_NAME     Sync repo name (default: .synctx)
  SYNCTX_LOCK_TTL      Lock timeout in ms (default: 300000)
`);
}

const { action, args } = parseArgs();

// Commands that require interactive first-run setup
const INTERACTIVE_COMMANDS = ['sync', 'restore', 'clean', 'list', 'list-copilot', 'list-claude', 'prune', 'delete', 'tag', 'untag', 'tags', 'uninstall', 'help', '-help', '--help', '-h'];

async function main() {
  // Clean up stale locks from crashed daemons
  Lock.cleanStale();

  // Run first-time setup for interactive commands (not push/daemon/setup)
  if (INTERACTIVE_COMMANDS.includes(action)) {
    try {
      await firstRunSetup();
    } catch (err) {
      console.error(`[warn] Setup failed: ${err.message}`);
      return;
    }
  }

  if (COMMANDS[action]) {
    await Promise.resolve(COMMANDS[action](args));
  } else {
    console.error(
      `Unknown action: "${action}". Use: push | restore | clean | list | delete | prune | help`,
    );
  }
}

main().catch((err) => {
  Logger.log('ERROR', `Command failed: ${err.message}`);
});
