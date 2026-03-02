#!/usr/bin/env node
'use strict';

/**
 * Synctx — Post-Install Setup
 *
 * Runs automatically after plugin installation. Performs:
 *   1. Prerequisite checks (git, gh, gitleaks) with install guidance
 *   2. GitHub CLI authentication check
 *   3. Ask user for sync repository name
 *   4. Bootstrap the private sync repository
 *   5. First sync (stage → scan → push)
 *
 * @license MIT
 */

const { execSync, execFileSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────

const isWin = os.platform() === 'win32';

/** Path to the user config file (persists repo name choice). */
const USER_CONFIG_FILE = path.join(os.homedir(), '.synctx', '.config.json');

/**
 * Ensure essential tool paths are in PATH.
 * Copilot CLI may run hooks with a stripped-down PATH.
 */
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

/** Check if a command exists. */
function commandExists(cmd) {
  try {
    execSync(`${isWin ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * On Windows, refresh PATH from registry to pick up newly installed tools.
 */
function refreshWindowsPath() {
  if (!isWin) return;
  try {
    const regExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const machRaw = execSync(
      `"${regExe}" query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path`,
      { encoding: 'utf8', windowsHide: true },
    );
    const userRaw = execSync(
      `"${regExe}" query "HKCU\\Environment" /v Path`,
      { encoding: 'utf8', windowsHide: true },
    );
    const machPath = machRaw.split('REG_EXPAND_SZ')[1]?.trim() || machRaw.split('REG_SZ')[1]?.trim() || '';
    const userPath = userRaw.split('REG_EXPAND_SZ')[1]?.trim() || userRaw.split('REG_SZ')[1]?.trim() || '';
    // Merge registry paths into the current PATH instead of replacing it,
    // so we don't lose paths added earlier in this process (e.g., extraPaths).
    const existing = new Set(process.env.PATH.split(';').filter(Boolean));
    for (const segment of (machPath + ';' + userPath).split(';').filter(Boolean)) {
      existing.add(segment);
    }
    process.env.PATH = [...existing].join(';');
  } catch { /* keep current PATH */ }
}

/** Get version string for a command. */
function getVersion(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      .trim().split('\n')[0];
  } catch {
    return null;
  }
}

/** Print a section header. */
function header(text) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${text}`);
  console.log('─'.repeat(60));
}

/** Prompt the user for input with a default value. */
function prompt(question, defaultValue) {
  return new Promise((resolve) => {
    // When run via curl|bash or piped stdin, process.stdin is the pipe, not the
    // terminal. Open /dev/tty directly to read from the real terminal.
    let input = process.stdin;
    if (!process.stdin.isTTY) {
      try {
        input = fs.createReadStream('/dev/tty');
      } catch {
        // /dev/tty unavailable (e.g., non-interactive CI) — use default
        resolve(defaultValue);
        return;
      }
    }

    const rl = readline.createInterface({
      input,
      output: process.stdout,
    });
    rl.question(`${question} [${defaultValue}]: `, (answer) => {
      rl.close();
      if (input !== process.stdin) {
        try { input.close(); } catch { /* best-effort */ }
      }
      resolve(answer.trim() || defaultValue);
    });
  });
}

/** Read persisted user config. */
function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Write persisted user config. */
function writeUserConfig(config) {
  const dir = path.dirname(USER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { c, progress } = require('./lib/format');

  // Banner — only show if run standalone
  if (!process.env.SYNCTX_INSTALLER) {
    const { printBanner } = require('./cli-art');
    printBanner();
    console.log(`  Synctx v${require('./lib/config').VERSION} — Setup\n`);
  }

  // ─── Prerequisites ────────────────────────────────────────────────────

  const p1 = progress('Prerequisites');
  const tools = ['node', 'git', 'gh', 'gitleaks'];
  let allGood = true;

  for (const tool of tools) {
    p1.update(`Checking ${tool}...`);
    if (!commandExists(tool)) {
      allGood = false;
      // Try auto-install
      p1.update(`Installing ${tool}...`);
      try {
        if (isWin) {
          const ids = { node: 'OpenJS.NodeJS.LTS', git: 'Git.Git', gh: 'GitHub.cli', gitleaks: 'Gitleaks.Gitleaks' };
          execSync(`winget install --id ${ids[tool]} -e --accept-source-agreements --accept-package-agreements --silent`, { stdio: 'ignore', windowsHide: true });
          refreshWindowsPath();
        } else if (commandExists('brew')) {
          execSync(`brew install ${tool}`, { stdio: 'ignore' });
        }
        if (commandExists(tool)) allGood = true;
      } catch { /* continue */ }
    }
  }

  if (isWin) {
    p1.update('Checking PowerShell Core...');
    if (!commandExists('pwsh')) {
      p1.update('Installing PowerShell Core...');
      try { execSync('winget install --id Microsoft.PowerShell -e --accept-source-agreements --accept-package-agreements --silent', { stdio: 'ignore', windowsHide: true }); } catch {}
    }
  }

  if (allGood) {
    p1.done('Prerequisites ready');
  } else {
    p1.fail('Some prerequisites missing — install manually and retry');
    return;
  }

  // ─── GitHub Auth ──────────────────────────────────────────────────────

  const p2 = progress('Auth');
  p2.update('Checking GitHub authentication...');

  let ghAuthenticated = false;
  try {
    execSync('gh auth status', { stdio: 'ignore', windowsHide: true });
    ghAuthenticated = true;
  } catch {}

  if (!ghAuthenticated) {
    p2.update('Running gh auth login...');
    try {
      execSync('gh auth login', { stdio: 'inherit', windowsHide: true });
      execSync('gh auth status', { stdio: 'ignore', windowsHide: true });
      ghAuthenticated = true;
    } catch {
      p2.fail('Authentication failed — run: gh auth login');
      return;
    }
  }

  const user = execSync('gh api user --jq .login', { encoding: 'utf8', windowsHide: true }).trim();
  p2.done(`Authenticated as ${user}`);

  // ─── Repository Config ────────────────────────────────────────────────

  const existingConfig = readUserConfig();
  let repoName;

  if (existingConfig.repoName) {
    repoName = existingConfig.repoName;
    const p3 = progress('Repo');
    p3.done(`Sync repository: ${repoName}`);
  } else {
    const defaultRepo = '.synctx';
    console.log(`\n  ${c.dim}The plugin creates a private GitHub repository for your sessions.${c.reset}`);
    repoName = await prompt('  Repository name', defaultRepo);
    console.log('');
  }

  const userConfig = { ...existingConfig, repoName };
  writeUserConfig(userConfig);
  process.env.SYNCTX_REPO_NAME = repoName;

  // ─── Bootstrap ────────────────────────────────────────────────────────

  const p4 = progress('Setup');
  p4.update('Bootstrapping repository...');

  let clonedExisting = false;
  try {
    delete require.cache[require.resolve('./lib/config')];
    const { CONFIG } = require('./lib/config');
    const ghUser = execSync('gh api user --jq .login', { encoding: 'utf8', windowsHide: true }).trim();

    try {
      execFileSync('gh', ['repo', 'view', `${ghUser}/${repoName}`, '--json', 'name'], { stdio: 'ignore', windowsHide: true });
      clonedExisting = true;
    } catch {}

    const GitManager = require('./lib/git-manager');
    GitManager.bootstrap();

    if (clonedExisting) {
      p4.update('Pulling existing data...');
      try {
        execFileSync('git', ['pull', 'origin', CONFIG.branch || 'main', '--allow-unrelated-histories', '-X', 'theirs', '--no-edit'], {
          cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
        });
      } catch {}
    }

    p4.done('Repository ready');
  } catch (error) {
    p4.fail(`Bootstrap failed: ${error.message}`);
    return;
  }

  // ─── First Sync ───────────────────────────────────────────────────────

  try {
    delete require.cache[require.resolve('./lib/config')];
    const SecurityScanner = require('./lib/security');
    const FileManager = require('./lib/file-manager');
    const GitManager = require('./lib/git-manager');

    // Stage
    const ps = progress('Stage');
    ps.update('Copying session files...');
    const ignoreContent = SecurityScanner.preserveIgnoreFile();
    const result = FileManager.stageFiles();
    SecurityScanner.restoreIgnoreFile(ignoreContent);

    if (result.files > 0) {
      const mb = (result.bytes / (1024 * 1024)).toFixed(2);
      ps.done(`Staged ${result.files} files (${mb} MB)`);

      // Security scan
      const sc = progress('Security');
      sc.update('Scanning for secrets (gitleaks)...');
      SecurityScanner.check();
      sc.done('Security scan passed');

      // Push with retry
      const pp = progress('Push');
      let pushed = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        pp.update(attempt === 1 ? 'Pushing to remote...' : `Retrying push (attempt ${attempt})...`);
        try {
          GitManager.sync();
          pushed = true;
          break;
        } catch {
          if (attempt < 3) {
            const wait = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };
            wait(3000);
          }
        }
      }
      if (pushed) {
        pp.done('Pushed to remote');
      } else {
        pp.skip('Push deferred — will sync automatically on next use');
      }
    } else {
      ps.done('No sessions yet — will sync automatically');
    }
  } catch (error) {
    const pErr = progress('Sync');
    pErr.skip(`Sync deferred: ${error.message}`);
  }

  // ─── Done ──────────────────────────────────────────────────────────────

  header('Setup Complete');
  console.log('  >> Synctx is ready!');
  console.log('');
  console.log('  Sessions will sync automatically on:');
  console.log('    • Every tool use (postToolUse hook)');
  console.log('    • Session exit (sessionEnd hook)');
  console.log('');
  console.log('  Available commands:');
  console.log('    list              — Show all synced sessions');
  console.log('    restore           — Pull and restore sessions');
  console.log('    delete <id>       — Delete a session');
  console.log('    push              — Manual sync');
  console.log('    clean             — Wipe local session files');
  console.log('    help              — Show all commands');
  console.log('');
}

main().catch((err) => {
  console.error(`[warn] Setup error: ${err.message}`);
});
