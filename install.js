#!/usr/bin/env node
'use strict';

/**
 * Synctx — One-Step Installer
 *
 * Installs the Copilot CLI plugin and runs interactive setup in one command.
 *
 * Usage:
 *   node install.js                  # Install from current directory
 *   node install.js --uninstall      # Uninstall and clean up
 *
 * @license MIT
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginDir = __dirname;
const isWin = os.platform() === 'win32';

// ─────────────────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    ...opts,
  });
}

function runQuiet(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

if (process.argv.includes('--uninstall')) {
  console.log('\n  [remove] Uninstalling Synctx...\n');

  // Step 1: Remove global CLI command
  try {
    execSync('npm unlink -g synctx', { stdio: 'pipe', windowsHide: true });
    console.log('  [ok] Global command removed.');
  } catch {
    console.log('  [-] Global command not found — skipping.');
  }

  // Step 2: Run data cleanup (staging dir, remote repo, Claude hooks)
  try {
    run(`node "${path.join(pluginDir, 'scripts', 'uninstall.js')}"`);
  } catch {
    console.log('  [-] Data cleanup skipped or encountered an issue.');
  }

  // Step 3: Remove Copilot CLI plugin
  try {
    execSync('copilot plugin uninstall synctx', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    console.log('  [ok] Plugin uninstalled from Copilot CLI.');
  } catch {
    console.log('  [-] Copilot CLI plugin not found — skipping.');
  }

  // Step 4: Remove the plugin clone directory (~/.synctx-plugin)
  const pluginCloneDir = path.join(os.homedir(), '.synctx-plugin');
  if (fs.existsSync(pluginCloneDir)) {
    try {
      fs.rmSync(pluginCloneDir, { recursive: true, force: true });
      console.log(`  [ok] Plugin directory removed: ${pluginCloneDir}`);
    } catch {
      console.log(`  [-] Could not remove ${pluginCloneDir} — remove manually.`);
    }
  }

  console.log('\n  [ok] Uninstall complete.\n');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────

const { printBanner } = require(path.join(pluginDir, 'scripts', 'cli-art'));
const { progress } = require(path.join(pluginDir, 'scripts', 'lib', 'format'));
printBanner();
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
console.log(`  Synctx v${pkg.version}\n`);

// Step 1: Check Copilot CLI
const p1 = progress('Copilot CLI');
p1.update('Checking...');
const copilotVersion = runQuiet('copilot --version');
if (!copilotVersion) {
  p1.fail('GitHub Copilot CLI not found. Install: https://docs.github.com/en/copilot/github-copilot-in-the-cli');
  process.exit(1);
}
p1.done(`Copilot CLI ${copilotVersion.split('\n')[0]}`);

// Step 2: Pull latest
if (fs.existsSync(path.join(pluginDir, '.git'))) {
  const p2 = progress('Update');
  p2.update('Pulling latest...');
  try {
    execSync('git pull --quiet origin main', { cwd: pluginDir, stdio: 'pipe', windowsHide: true });
    p2.done('Updated to latest version');
  } catch {
    p2.skip('Could not pull latest');
  }
}

// Step 3: Install plugin (retry up to 3 times)
const p3 = progress('Plugin');
let pluginInstalled = false;
for (let attempt = 1; attempt <= 3; attempt++) {
  p3.update(attempt === 1 ? 'Installing...' : `Retrying install (attempt ${attempt})...`);
  try {
    try {
      execSync('copilot plugin uninstall synctx', { stdio: 'pipe', windowsHide: true });
    } catch { /* may not be installed */ }
    // Wait for file handles to release
    const wait = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };
    wait(2000);
    execSync(`copilot plugin install "${pluginDir}"`, { stdio: 'pipe', windowsHide: true });
    pluginInstalled = true;
    break;
  } catch {
    if (attempt < 3) {
      p3.update(`Install attempt ${attempt} failed, waiting...`);
      const wait = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };
      wait(3000);
    }
  }
}
if (pluginInstalled) {
  p3.done('Plugin installed');
} else {
  p3.fail('Plugin install failed after 3 attempts');
  console.log('     Try: close all terminals, then re-run this installer.\n');
  // Continue with other steps — don't exit
}

// Step 4: Global CLI command
const p4 = progress('CLI');
p4.update('Creating global command...');
try {
  execSync('npm link --ignore-scripts', {
    cwd: pluginDir, stdio: 'pipe', windowsHide: true, timeout: 30000,
  });
  p4.done('Global command: synctx');
} catch {
  p4.skip('Global command skipped — use /synctx in Copilot CLI');
}

// Step 5: Run interactive setup
console.log('');
try {
  process.env.SYNCTX_INSTALLER = '1';
  run(`node "${path.join(pluginDir, 'scripts', 'postinstall.js')}"`, { env: { ...process.env, SYNCTX_INSTALLER: '1' } });
} catch {
  console.log('\n  [warn] Setup encountered an issue. You can retry later:');
  console.log('     /synctx setup\n');
}

// Final retry: if plugin didn't install earlier, try once more now
if (!pluginInstalled) {
  const pRetry = progress('Plugin');
  pRetry.update('Final install attempt...');
  try {
    execSync(`copilot plugin install "${pluginDir}"`, { stdio: 'pipe', windowsHide: true });
    pRetry.done('Plugin installed on retry');
  } catch {
    pRetry.fail('Plugin still not installed — run: copilot plugin install ' + pluginDir);
  }
}
