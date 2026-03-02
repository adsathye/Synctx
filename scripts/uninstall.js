#!/usr/bin/env node
'use strict';

/**
 * Synctx — Uninstall Cleanup
 *
 * Removes all local data and optionally deletes the remote sync repository.
 * Run this before `copilot plugin uninstall synctx`.
 *
 * @license MIT
 */

const { execSync, execFileSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const fs = require('fs');
const path = require('path');

const isWin = os.platform() === 'win32';

// ─────────────────────────────────────────────────────────────────────────────

/** Prompt user for input. */
function ask(question) {
  return new Promise((resolve) => {
    let input = process.stdin;
    if (!process.stdin.isTTY) {
      try {
        input = fs.createReadStream('/dev/tty');
      } catch {
        resolve('');
        return;
      }
    }
    const rl = readline.createInterface({ input, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      if (input !== process.stdin) {
        try { input.close(); } catch { /* best-effort */ }
      }
      resolve(answer.trim().toLowerCase());
    });
  });
}

/** Recursively remove a directory. */
function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Get GitHub username. */
function getGitHubUser() {
  try {
    return execSync('gh api user --jq .login', {
      encoding: 'utf8', windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** Read user config to get repo name. */
function getRepoName() {
  const configFile = path.join(os.homedir(), '.synctx', '.config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return config.repoName || '.synctx';
  } catch {
    return '.synctx';
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const syncDir = path.join(os.homedir(), '.synctx');
  const repoName = getRepoName();

  console.log('\n  [remove] Synctx — Uninstall\n');
  console.log(`  This will remove:`);
  console.log(`    • Local sync directory: ${syncDir}`);
  console.log(`    • Configuration and audit logs`);
  console.log(`    • Claude Code hooks (if installed)\n`);

  // ─── Confirmation 1 ────────────────────────────────────────────────────

  const confirm1 = await ask('  Are you sure you want to uninstall? (Y/n): ');
  if (confirm1 === 'no' || confirm1 === 'n') {
    console.log('  Cancelled.\n');
    return;
  }

  // ─── Ask about remote repo ─────────────────────────────────────────────

  const user = getGitHubUser();
  let deleteRemote = false;

  if (user) {
    console.log(`\n  The remote sync repository is: ${user}/${repoName}`);
    console.log('  Deleting it will permanently remove all synced session data.\n');

    const confirmRemote = await ask('  Delete the remote repository too? (y/N): ');
    deleteRemote = confirmRemote === 'yes' || confirmRemote === 'y';

    if (deleteRemote) {
      const confirmRemote2 = await ask(`  Type the repo name "${repoName}" to confirm deletion: `);
      if (confirmRemote2 !== repoName) {
        console.log('  Repo name mismatch — remote will NOT be deleted.\n');
        deleteRemote = false;
      }
    }
  }

  // ─── Remove Claude hooks ───────────────────────────────────────────────

  try {
    const setupPath = path.join(__dirname, 'setup.js');
    if (fs.existsSync(setupPath)) {
      execFileSync(process.execPath, [setupPath, 'uninstall'], {
        stdio: 'ignore', windowsHide: true,
      });
      console.log('  [ok] Claude Code hooks removed.');
    }
  } catch {
    // Claude hooks may not exist — fine
  }

  // ─── Delete remote repo ────────────────────────────────────────────────

  if (deleteRemote) {
    // Determine repo owner from git remote (not gh active user — may differ)
    let repoOwner = user;
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: path.join(os.homedir(), '.synctx'), encoding: 'utf8', windowsHide: true,
      }).trim();
      const match = remoteUrl.match(/github\.com[/:]([^/]+)\//);
      if (match) repoOwner = match[1];
    } catch { /* fall back to gh user */ }

    try {
      execFileSync('gh', ['repo', 'delete', `${repoOwner}/${repoName}`, '--yes'], {
        stdio: 'ignore', windowsHide: true,
      });
      console.log(`  [ok] Remote repository '${repoOwner}/${repoName}' deleted.`);
    } catch {
      console.log(`  [warn] Failed to delete remote repo. Delete manually at:`);
      console.log(`     https://github.com/${repoOwner}/${repoName}/settings`);
      console.log(`     (You may need to switch gh accounts: gh auth switch)`);
    }
  }

  // ─── Delete local staging directory ────────────────────────────────────

  try {
    rmrf(syncDir);
    console.log(`  [ok] Local directory removed: ${syncDir}`);
  } catch (err) {
    console.log(`  [warn] Failed to remove ${syncDir}: ${err.message}`);
    if (isWin) {
      console.log(`     Try manually: rmdir /s /q "${syncDir}"`);
    } else {
      console.log(`     Try manually: rm -rf "${syncDir}"`);
    }
  }

  // ─── Done ──────────────────────────────────────────────────────────────

  // Remove global CLI command (npm link)
  try {
    execSync('npm unlink -g synctx', { stdio: 'pipe', windowsHide: true });
    console.log('  [ok] Global "synctx" command removed.');
  } catch {
    // may not have been linked
  }

  // Uninstall Copilot CLI plugin
  try {
    execSync('copilot plugin uninstall synctx', { stdio: 'pipe', windowsHide: true });
    console.log('  [ok] Copilot CLI plugin uninstalled.');
  } catch {
    // plugin may not be installed
  }

  // Remove the plugin clone directory
  const pluginCloneDir = path.join(os.homedir(), '.synctx-plugin');
  if (fs.existsSync(pluginCloneDir)) {
    try {
      rmrf(pluginCloneDir);
      console.log(`  [ok] Plugin directory removed: ${pluginCloneDir}`);
    } catch {
      console.log(`  [-] Could not remove ${pluginCloneDir} — remove manually.`);
    }
  }

  console.log('\n  [ok] Synctx fully uninstalled.\n');

  if (!deleteRemote && user) {
    console.log(`  ℹ  Remote repo '${user}/${repoName}' was kept. Delete it manually if needed:`);
    console.log(`     https://github.com/${user}/${repoName}/settings\n`);
  }
}

main().catch((err) => {
  console.error(`[warn] Uninstall error: ${err.message}`);
});
