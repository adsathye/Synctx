'use strict';

/**
 * @module git-manager
 * @description Manages the Git lifecycle for the private sync repository.
 *
 * Responsible for:
 *   - Bootstrapping (creating/cloning the remote private repo)
 *   - Committing & pushing staged changes with smart commit messages
 *   - Pulling the latest data for restore
 *
 * @license MIT
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');
const Logger = require('./logger');
const Lock = require('./lock');

// ─────────────────────────────────────────────────────────────────────────────
// Safe Git Execution — all git commands are forced to run in CONFIG.syncDir
// ─────────────────────────────────────────────────────────────────────────────

/** Default options for all git commands — always targets the staging directory. */
const GIT_OPTS = Object.freeze({ cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });

/**
 * Validate that a cwd path is the staging directory.
 * Prevents git commands from accidentally targeting user repos.
 *
 * @param {string} dir — The directory to validate.
 */
function assertSyncDir(dir) {
  const resolved = path.resolve(dir);
  const expected = path.resolve(CONFIG.syncDir);
  if (resolved !== expected) {
    throw new Error(`Git guardrail: refusing to run git in "${resolved}" (expected "${expected}")`);
  }
}

/**
 * Safe execFileSync wrapper — ensures cwd is always the staging directory.
 *
 * @param {string[]} args — Git arguments (e.g., ['add', '.']).
 * @param {Object} [opts] — Extra options (merged with GIT_OPTS).
 * @returns {Buffer|string}
 */
function gitExec(args, opts = {}) {
  const merged = { ...GIT_OPTS, ...opts, cwd: CONFIG.syncDir };
  assertSyncDir(merged.cwd);
  return execFileSync('git', args, merged);
}

/**
 * Git exec that captures stderr for diagnostic error messages.
 * Used for push/pull where silent failures are hard to debug.
 *
 * @param {string[]} args — Git arguments.
 * @returns {string}
 */
function gitExecWithStderr(args) {
  try {
    return execFileSync('git', args, {
      ...GIT_OPTS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    const stderr = error.stderr ? error.stderr.trim() : '';
    throw new Error(`${error.message}${stderr ? ' — ' + stderr : ''}`);
  }
}

/**
 * Safe execSync wrapper for git commands that need string output.
 *
 * @param {string} cmd — Git command string (e.g., 'git status --porcelain').
 * @param {Object} [opts] — Extra options.
 * @returns {string}
 */
function gitExecStr(cmd, opts = {}) {
  const merged = { encoding: 'utf8', windowsHide: true, ...opts, cwd: CONFIG.syncDir };
  assertSyncDir(merged.cwd);
  return execSync(cmd, merged);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the staging directory has a Git repository linked to a private
 * GitHub remote. Creates the remote repository if it doesn't exist.
 */
function bootstrap() {
  // Ensure essential git configs are always set (even on re-runs)
  if (fs.existsSync(path.join(CONFIG.syncDir, '.git'))) {
    // Always ensure credential helper and identity are configured
    try {
      gitExec(['config', 'credential.helper', '!gh auth git-credential']);
      gitExec(['config', 'user.name', 'Synctx']);
      gitExec(['config', 'user.email', 'synctx@noreply']);
      gitExec(['config', 'core.autocrlf', 'false']);
      gitExec(['config', 'core.safecrlf', 'false']);
    } catch { /* best-effort on existing repos */ }

    // Check if current remote is reachable — if so, keep it
    try {
      const currentRemote = gitExecStr('git remote get-url origin').trim();
      if (currentRemote) {
        // Test if remote is reachable
        try {
          gitExec(['ls-remote', '--exit-code', 'origin', 'HEAD']);
          return; // Remote works — fully bootstrapped
        } catch {
          // Remote is broken (404, auth fail) — try to fix it
          Logger.log('INFO', `Remote unreachable: ${currentRemote}`);
          const user = execSync('gh api user --jq .login', {
            encoding: 'utf8', windowsHide: true,
          }).trim();
          const expectedUrl = `https://${CONFIG.gitHost}/${user}/${CONFIG.repoName}.git`;

          if (currentRemote !== expectedUrl) {
            Logger.log('INFO', `Updating remote: ${currentRemote} → ${expectedUrl}`);
            gitExec(['remote', 'set-url', 'origin', expectedUrl]);

            // Ensure the remote repo exists
            try {
              execFileSync('gh', ['repo', 'view', `${user}/${CONFIG.repoName}`, '--json', 'name'], {
                stdio: 'ignore', windowsHide: true,
              });
            } catch {
              try {
                execFileSync('gh', ['repo', 'create', CONFIG.repoName, '--private'], {
                  stdio: 'ignore', windowsHide: true,
                });
                Logger.log('INFO', `Private sync repository '${CONFIG.repoName}' created.`);
              } catch { /* may already exist */ }
            }
          }

          return; // Bootstrapped with updated remote
        }
      }
    } catch {
      // No remote configured — fall through to full bootstrap
    }
  }

  // Verify prerequisites
  try {
    execSync('gitleaks version', { stdio: 'ignore', windowsHide: true });
  } catch {
    Logger.log('ERROR', 'Gitleaks is not installed. Install from https://github.com/gitleaks/gitleaks');
    throw new Error('Gitleaks not installed');
  }

  try {
    execSync('gh auth status', { stdio: 'ignore', windowsHide: true });
  } catch {
    Logger.log('ERROR', 'GitHub CLI is not authenticated. Run: gh auth login');
    throw new Error('GitHub CLI not authenticated');
  }

  if (!fs.existsSync(CONFIG.syncDir)) {
    fs.mkdirSync(CONFIG.syncDir, { recursive: true });
  }

  // Get GitHub username
  const user = execSync('gh api user --jq .login', {
    encoding: 'utf8', windowsHide: true,
  }).trim();
  if (!/^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?$/.test(user)) {
    throw new Error(`Invalid GitHub username format: "${user}"`);
  }

  const repoUrl = `https://${CONFIG.gitHost}/${user}/${CONFIG.repoName}.git`;

  // Check if remote repo exists
  let repoExists = false;
  try {
    execFileSync('gh', ['repo', 'view', `${user}/${CONFIG.repoName}`, '--json', 'name'], {
      stdio: 'ignore', windowsHide: true,
    });
    repoExists = true;
  } catch { /* doesn't exist yet */ }

  if (!repoExists) {
    try {
      execFileSync('gh', [
        'repo', 'create', CONFIG.repoName, '--private',
      ], { stdio: 'ignore', windowsHide: true });
      Logger.log('INFO', `Private sync repository '${CONFIG.repoName}' created.`);
    } catch (error) {
      Logger.log('ERROR', `Failed to create repo: ${error.message}`);
      throw new Error('Bootstrap failed — could not create repository');
    }
  }

  // Init git in the syncDir and connect to remote
  try {
    if (!fs.existsSync(path.join(CONFIG.syncDir, '.git'))) {
      gitExec(['init']);
    }

    // Prevent CRLF warnings/failures on Windows — session files have mixed line endings
    gitExec(['config', 'core.autocrlf', 'false']);
    // Prevent git from warning about initial branch name
    gitExec(['config', 'core.safecrlf', 'false']);
    // Configure gh as the credential helper for this repo so git push
    // can authenticate without prompting (stdio: 'ignore' blocks prompts)
    gitExec(['config', 'credential.helper', '!gh auth git-credential']);
    // Set a dedicated identity for sync commits (local to this repo only)
    gitExec(['config', 'user.name', 'Synctx']);
    gitExec(['config', 'user.email', 'synctx@noreply']);

    // Set or add remote (handles re-runs safely)
    try {
      gitExec(['remote', 'set-url', 'origin', repoUrl]);
    } catch {
      gitExec(['remote', 'add', 'origin', repoUrl]);
    }

    if (repoExists) {
      try {
        gitExec(['fetch', 'origin']);
        gitExec(['checkout', '-b', CONFIG.branch, `origin/${CONFIG.branch}`]);
        Logger.log('INFO', 'Existing sync repository cloned and checked out.');
      } catch {
        try {
          gitExec(['checkout', CONFIG.branch]);
        } catch {
          gitExec(['checkout', '-b', CONFIG.branch]);
        }
        Logger.log('INFO', 'sync repository initialized.');
      }
    } else {
      try {
        gitExec(['checkout', '-b', CONFIG.branch]);
      } catch {
        gitExec(['checkout', CONFIG.branch]);
      }
      Logger.log('INFO', 'New sync repository initialized.');
    }

    // Ensure .gitignore covers all internal/operational files.
    // Written AFTER checkout to avoid untracked-file conflict when the
    // remote already has a .gitignore (second machine bootstrap).
    const gitignorePath = path.join(CONFIG.syncDir, '.gitignore');
    const ignoreEntries = [
      '.config.json',
      '.sync_lock',
      '.last_sync',
      '.last_gc',
      '.DS_Store',
      'security-audit/*.log',
      'security-audit/**/*.log',
    ];
    const ignoreContent = ignoreEntries.join('\n') + '\n';
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (existing !== ignoreContent) {
      fs.writeFileSync(gitignorePath, ignoreContent);
      // Untrack any files that are now ignored but were previously committed
      try {
        gitExec(['rm', '-r', '--cached', '--ignore-unmatch', '.last_sync', '.last_gc',
          'security-audit/general.log', 'security-audit/copilot/copilot.log',
          'security-audit/claude/claude.log', '.DS_Store']);
      } catch { /* best-effort */ }
    }
  } catch (error) {
    Logger.log('ERROR', `Bootstrap git init failed: ${error.message}`);
    throw new Error('Bootstrap failed');
  }
}

/**
 * Shared commit and push logic with smart amend-within-window.
 *
 * If the last commit is within CONFIG.commitWindow (4 hours) and is ours
 * (matches "Secure Auto-sync" or "Clean:" or "Delete session:" prefix),
 * the commit is amended instead of creating a new one. This keeps the
 * git history at ~6 commits/day instead of hundreds.
 *
 * @param {string} message — Commit message.
 */
function commitAndPush(message) {
  // Remove stale .git/index.lock left by a previous crash (e.g., power loss
  // or SIGKILL during a git operation). Without this, all subsequent git
  // commands would fail with "Unable to create index.lock: File exists".
  const indexLock = path.join(CONFIG.syncDir, '.git', 'index.lock');
  if (fs.existsSync(indexLock)) {
    try { fs.unlinkSync(indexLock); } catch { /* race-safe */ }
    Logger.log('INFO', 'Removed stale .git/index.lock from previous crash.');
  }

  try {
    gitExec(['add', '.']);
  } catch (error) {
    throw new Error(`Failed to stage files in Git: ${error.message}`);
  }

  const status = gitExecStr('git status --porcelain').trim();

  if (!status) {
    return; // No changes to commit
  }

  // Check if this is the first commit (empty repo — no HEAD yet)
  // Use gitExec (stdio: 'ignore') to suppress stderr leak on empty repos
  let isFirstCommit = false;
  try {
    gitExec(['rev-parse', 'HEAD']);
  } catch {
    isFirstCommit = true;
  }

  // Only check amend if there's an existing commit history
  const shouldAmend = isFirstCommit ? false : canAmendLastCommit();

  try {
    if (!isFirstCommit && shouldAmend) {
      gitExec(['commit', '--amend', '-m', message]);
    } else {
      gitExec(['commit', '-m', message]);
    }
  } catch (error) {
    throw new Error(`Git commit failed: ${error.message}`);
  }

  // Refresh lock before the longest operation (push)
  Lock.refresh();

  if (isFirstCommit) {
    // First commit — try direct push, fall back to pull+push if remote has history
    try {
      gitExecWithStderr(['push', '-u', 'origin', CONFIG.branch]);
    } catch {
      try {
        try { gitExec(['stash']); } catch {}
        gitExec(['fetch', 'origin', CONFIG.branch]);
        try {
          gitExec(['merge', `origin/${CONFIG.branch}`, '--allow-unrelated-histories', '-X', 'theirs', '--no-edit']);
        } catch {
          try { gitExec(['checkout', '--theirs', '.']); gitExec(['add', '.']); gitExec(['commit', '--no-edit', '-m', 'Merge remote']); } catch {}
        }
        try { gitExec(['stash', 'pop']); } catch {}
        gitExecWithStderr(['push', '-u', 'origin', CONFIG.branch]);
      } catch (retryError) {
        throw new Error(`Git push failed: ${retryError.message}`);
      }
    }
  } else if (shouldAmend) {
    // Amend requires force-push; --force-with-lease is safe (rejects if
    // remote was updated by another device since our last fetch)
    try {
      gitExecWithStderr(['push', '--force-with-lease', 'origin', CONFIG.branch]);
    } catch {
      // force-with-lease rejected — another device pushed. Fall back to
      // normal pull+push (creates a merge commit, which is fine).
      try {
        try { gitExec(['stash']); } catch {}
        gitExec(['fetch', 'origin', CONFIG.branch]);
        try {
          gitExec(['merge', `origin/${CONFIG.branch}`, '--allow-unrelated-histories', '-X', 'theirs', '--no-edit']);
        } catch {
          try { gitExec(['checkout', '--theirs', '.']); gitExec(['add', '.']); gitExec(['commit', '--no-edit', '-m', 'Merge remote']); } catch {}
        }
        try { gitExec(['stash', 'pop']); } catch {}
        gitExecWithStderr(['push', 'origin', CONFIG.branch]);
      } catch (pushError) {
        throw new Error(`Git push failed: ${pushError.message}`);
      }
    }
  } else {
    // Normal push: stash → fetch → merge → pop → push
    try { gitExec(['stash']); } catch { /* nothing to stash */ }
    try {
      gitExec(['fetch', 'origin', CONFIG.branch]);
      try {
        gitExec(['merge', `origin/${CONFIG.branch}`, '--allow-unrelated-histories', '-X', 'theirs', '--no-edit']);
      } catch {
        try {
          gitExec(['checkout', '--theirs', '.']);
          gitExec(['add', '.']);
          gitExec(['commit', '--no-edit', '-m', 'Merge remote changes']);
        } catch { /* best effort */ }
      }
    } catch (pullError) {
      const msg = pullError.message || '';
      if (!msg.includes('no matching remote') && !msg.includes("couldn't find remote ref")) {
        Logger.log('ERROR', `Git pull encountered an issue: ${msg}`);
      }
    }
    try { gitExec(['stash', 'pop']); } catch { /* no stash */ }

    try {
      gitExecWithStderr(['push', 'origin', CONFIG.branch]);
    } catch (pushError) {
      throw new Error(`Git push failed: ${pushError.message}`);
    }
  }
}

/**
 * Check if the last commit can be amended (within the commit window and
 * created by this tool).
 *
 * @returns {boolean}
 */
function canAmendLastCommit() {
  try {
    const timestamp = gitExecStr('git log -1 --format=%ct').trim();

    if (!timestamp) {
      Logger.log('DEBUG', 'canAmend: no timestamp');
      return false;
    }

    const commitAge = Date.now() - (Number(timestamp) * 1000);
    if (commitAge > CONFIG.commitWindow) {
      Logger.log('DEBUG', `canAmend: too old (${Math.round(commitAge / 60000)}min > ${Math.round(CONFIG.commitWindow / 60000)}min)`);
      return false;
    }

    // Verify it's our commit (not a manual commit or from another tool)
    const subject = gitExecStr('git log -1 --format=%s').trim();

    const isOurCommit = subject.startsWith('Secure Auto-sync') ||
                        subject.startsWith('Clean:') ||
                        subject.startsWith('Delete session:') ||
                        subject.startsWith('Tag:');
    if (!isOurCommit) {
      Logger.log('DEBUG', `canAmend: not our commit — "${subject}"`);
      return false;
    }
  } catch (err) {
    Logger.log('DEBUG', `canAmend: check failed — ${err.message}`);
    return false;
  }

  // Safety: if remote has diverged (e.g., another device pushed), don't
  // amend — force-push could overwrite their changes even with --force-with-lease
  // if we haven't fetched yet.
  try {
    gitExec(['fetch', 'origin', CONFIG.branch]);
    const localHead = gitExecStr('git rev-parse HEAD').trim();
    const remoteHead = gitExecStr(`git rev-parse origin/${CONFIG.branch}`).trim();
    if (localHead !== remoteHead) {
      Logger.log('DEBUG', `canAmend: diverged — local=${localHead.slice(0,7)} remote=${remoteHead.slice(0,7)}`);
      return false;
    }
  } catch (err) {
    Logger.log('DEBUG', `canAmend: fetch/compare failed — ${err.message}`);
    return false; // Can't verify remote state, play it safe
  }

  Logger.log('DEBUG', 'canAmend: YES — will amend');
  return true;
}

/**
 * Commit and push staged changes to the remote sync repo.
 *
 * The commit message dynamically reflects which CLI(s) had changes
 * (Copilot, Claude, or both).
 */
function sync() {
  // Remove stale .git/index.lock before any git operations
  const indexLock = path.join(CONFIG.syncDir, '.git', 'index.lock');
  if (fs.existsSync(indexLock)) {
    try { fs.unlinkSync(indexLock); } catch { /* race-safe */ }
    Logger.log('INFO', 'Removed stale .git/index.lock from previous crash.');
  }

  const dateStr = new Date()
    .toISOString()
    .replace(/T/, ' ')
    .replace(/\..+/, '');

  // Check what changed before committing
  let status;
  try {
    gitExec(['add', '.']);
    status = gitExecStr('git status --porcelain').trim();
  } catch (error) {
    Logger.log('ERROR', `Git status check failed: ${error.message}`);
    throw error;
  }

  if (!status) {
    Logger.log('INFO', 'No changes to sync.');
    return;
  }

  // Detect which CLI state actually changed
  const changedCLIs = [];
  if (status.includes('github-copilot/')) changedCLIs.push('Copilot');
  if (status.includes('claude/')) changedCLIs.push('Claude');
  const cliLabel = changedCLIs.length > 0 ? changedCLIs.join(' & ') : 'General';

  const commitMessage = `Secure Auto-sync (${cliLabel}): ${dateStr}`;

  try {
    commitAndPush(commitMessage);
  } catch (error) {
    Logger.log('ERROR', error.message);
    throw error;
  }

  // Save last-sync timestamp
  try {
    fs.writeFileSync(CONFIG.lastSyncFile, new Date().toISOString());
  } catch { /* best-effort */ }

  Logger.log('INFO', `Successfully synced ${cliLabel} session data to remote.`);

  if (status.includes('github-copilot/')) {
    Logger.log('INFO', `Copilot session data synced.`, { cli: 'github-copilot' });
  }
  if (status.includes('claude/')) {
    Logger.log('INFO', `Claude session data synced.`, { cli: 'claude' });
  }

  // Periodic aggressive garbage collection — compresses git objects to save disk.
  // Only runs once per gcInterval (default 24h) since it can be slow on large repos.
  // Safe: only repackages existing committed objects, never deletes data.
  try {
    let shouldGc = true;
    try {
      if (fs.existsSync(CONFIG.lastGcFile)) {
        const ts = fs.readFileSync(CONFIG.lastGcFile, 'utf8').trim();
        const age = Date.now() - new Date(ts).getTime();
        shouldGc = age > CONFIG.gcInterval;
      }
    } catch { /* first gc run */ }

    if (shouldGc) {
      Logger.log('INFO', 'Running git gc --aggressive (periodic maintenance)...');
      gitExec(['gc', '--aggressive', '--prune=now']);
      fs.writeFileSync(CONFIG.lastGcFile, new Date().toISOString());
      Logger.log('INFO', 'Git gc completed.');
    }
  } catch {
    /* non-critical — skip on failure */
  }
}

/**
 * Pull the latest data from the remote repository into the staging directory.
 *
 * SAFETY: This function ONLY writes to ~/.synctx/ (the staging dir).
 * It NEVER modifies the user's original CLI directories.
 *
 * Sessions are available in the staging directory for the restore-session
 * skill to read and hot-load into AI memory.
 */
function restore() {
  bootstrap();

  Logger.log('USER_ACTION', 'Initiating session restore pull from remote.');

  try {
    gitExec(['pull', 'origin', CONFIG.branch, '--allow-unrelated-histories', '-X', 'theirs', '--no-edit']);
  } catch {
    Logger.log('INFO', 'Remote pull skipped (repository may be empty).');
  }

  console.log(
    `\n[ok] Restore complete. Sessions are available in:\n   ${CONFIG.syncDir}\n`,
  );
  console.log(
    'Use the restore-session skill to hot-load a specific session into memory.',
  );
  console.log(
    'Note: Original CLI directories are NOT modified — sessions are read from the sync directory.\n',
  );
}

module.exports = { bootstrap, sync, restore, commitAndPush };
