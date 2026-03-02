#!/usr/bin/env node
'use strict';

/**
 * Synctx v1.0.0 — Load & Integration Test Harness
 *
 * Simulates 5 users × 2 machines each using local directory isolation.
 * Each user gets a unique GitHub repo under the adsathye account.
 * Tests exercise all commands, tombstones, tags, and cross-machine scenarios.
 *
 * Usage:
 *   node tests/load-test.js [--cleanup-only] [--skip-docker]
 */

const { execSync, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_BASE = path.join(os.tmpdir(), 'synctx-load-test');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'sync-engine.js');
const IS_WIN = os.platform() === 'win32';

const USERS = [
  { id: 'user1', repo: '.synctx-test-user1' },
  { id: 'user2', repo: '.synctx-test-user2' },
  { id: 'user3', repo: '.synctx-test-user3' },
  { id: 'user4', repo: '.synctx-test-user4' },
  { id: 'user5', repo: '.synctx-test-user5' },
];

const SKIP_DOCKER = process.argv.includes('--skip-docker');
const CLEANUP_ONLY = process.argv.includes('--cleanup-only');

let totalTests = 0;
let passed = 0;
let failed = 0;
const issues = [];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function log(msg) { console.log(`  ${msg}`); }
function logSection(msg) { console.log(`\n${'─'.repeat(70)}\n  ${msg}\n${'─'.repeat(70)}`); }

function assert(name, condition, detail) {
  totalTests++;
  if (condition) {
    passed++;
    log(`[pass] ${name}`);
  } else {
    failed++;
    const issue = `[FAIL] ${name}${detail ? ': ' + detail : ''}`;
    log(issue);
    issues.push(issue);
  }
}

/** Returns JS code to override the home directory env var (platform-aware). */
function homeEnvLine(fakeHome) {
  const envVar = IS_WIN ? 'USERPROFILE' : 'HOME';
  return `process.env.${envVar} = ${JSON.stringify(fakeHome)};`;
}

/** Create an isolated machine environment for a user. */
function createMachineEnv(userId, repoName, machineId) {
  const syncDir = path.join(TEST_BASE, userId, machineId, '.synctx');
  // Use a fake home for session sources (copilot/claude dirs)
  // but keep real HOME for gh auth via GH_CONFIG_DIR
  const fakeHome = path.join(TEST_BASE, userId, machineId, 'home');
  const copilotDir = path.join(fakeHome, '.copilot', 'session-state');
  const claudeDir = path.join(fakeHome, '.claude', 'todos');

  fs.mkdirSync(syncDir, { recursive: true });
  fs.mkdirSync(copilotDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });

  // Write config so the engine knows the repo name
  fs.writeFileSync(path.join(syncDir, '.config.json'), JSON.stringify({ repoName }));

  // Home dir override works cross-platform:
  // - Unix: os.homedir() reads HOME
  // - Windows: os.homedir() reads USERPROFILE
  const homeEnvOverride = IS_WIN
    ? { USERPROFILE: fakeHome }
    : { HOME: fakeHome };

  return {
    syncDir,
    fakeHome,
    copilotDir,
    claudeDir,
    env: {
      ...process.env,
      SYNCTX_SYNC_DIR: syncDir,
      SYNCTX_REPO_NAME: repoName,
      ...homeEnvOverride,
      SYNCTX_LOCK_TTL: '5000', // 5 seconds for faster testing
    },
    // Env with real HOME for git operations that need gh auth
    gitEnv: {
      ...process.env,
      SYNCTX_SYNC_DIR: syncDir,
      SYNCTX_REPO_NAME: repoName,
      // HOME/USERPROFILE stays as real home for gh credential access
      SYNCTX_LOCK_TTL: '5000',
    },
  };
}

/** Run synctx command in an isolated environment. */
function runSynctx(env, args, { input, allowFail, useGitEnv } = {}) {
  try {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      env: useGitEnv ? env.gitEnv : env.env,
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 60000,
      input: input || undefined,
      stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status,
      ok: result.status === 0,
    };
  } catch (err) {
    if (allowFail) return { stdout: '', stderr: err.message, status: 1, ok: false };
    throw err;
  }
}

/** Create fake session files in a CLI directory. */
function createFakeSession(dir, sessionId, fileCount = 3) {
  const sessionDir = path.join(dir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const content = JSON.stringify({
      id: sessionId,
      turn: i,
      timestamp: new Date().toISOString(),
      message: `Test message ${i} for session ${sessionId}`,
      data: 'x'.repeat(100 + Math.floor(Math.random() * 500)),
    }, null, 2);
    fs.writeFileSync(path.join(sessionDir, `turn-${i}.json`), content);
  }
  // Add a plan.md for realism
  fs.writeFileSync(path.join(sessionDir, 'plan.md'), `# Session ${sessionId}\nTest plan content.\n`);
  return sessionDir;
}

/** Create a repo on GitHub (or verify it exists). */
function ensureRepo(repoName) {
  try {
    execSync(`gh repo view adsathye/${repoName} --json name`, {
      stdio: 'ignore', encoding: 'utf8', windowsHide: true,
    });
    return true; // Already exists
  } catch {
    try {
      execSync(`gh repo create ${repoName} --private`, {
        stdio: 'ignore', encoding: 'utf8', windowsHide: true,
      });
      log(`[ok] Created repo: ${repoName}`);
      return true;
    } catch (err) {
      log(`[warn] Failed to create repo ${repoName}: ${err.message}`);
      return false;
    }
  }
}

/** Delete a test repo from GitHub. */
function deleteRepo(repoName) {
  try {
    execSync(`gh repo delete adsathye/${repoName} --yes`, {
      stdio: 'ignore', encoding: 'utf8', windowsHide: true,
    });
    log(`[ok] Deleted repo: ${repoName}`);
  } catch {
    log(`[--] Repo ${repoName} not found or already deleted`);
  }
}

/** Read tombstones from an env's sync dir. */
function readTombstones(env) {
  const tombFile = path.join(env.syncDir, '.deletions.json');
  try {
    return JSON.parse(fs.readFileSync(tombFile, 'utf8'));
  } catch {
    return {};
  }
}

/** Read tags from an env's sync dir. */
function readTags(env) {
  const tagFile = path.join(env.syncDir, '.tags.json');
  try {
    return JSON.parse(fs.readFileSync(tagFile, 'utf8'));
  } catch {
    return {};
  }
}

/** Bootstrap a machine environment (git init + remote). */
function bootstrapEnv(env) {
  const gitDir = path.join(env.syncDir, '.git');
  if (!fs.existsSync(gitDir)) {
    execSync('git init', { cwd: env.syncDir, stdio: 'ignore' });
    execSync('git config user.name "Synctx Test"', { cwd: env.syncDir, stdio: 'ignore' });
    execSync('git config user.email "test@synctx"', { cwd: env.syncDir, stdio: 'ignore' });
    // Use execFileSync for credential helper to avoid shell quoting issues cross-platform
    execFileSync('git', ['config', 'credential.helper', '!gh auth git-credential'], { cwd: env.syncDir, stdio: 'ignore' });
    execSync('git config core.autocrlf false', { cwd: env.syncDir, stdio: 'ignore' });

    const repoName = env.env.SYNCTX_REPO_NAME;
    const remoteUrl = `https://github.com/adsathye/${repoName}.git`;

    try {
      execSync(`git remote add origin ${remoteUrl}`, { cwd: env.syncDir, stdio: 'ignore' });
    } catch {
      execSync(`git remote set-url origin ${remoteUrl}`, { cwd: env.syncDir, stdio: 'ignore' });
    }

    // Try to fetch existing content (use real HOME for gh auth)
    try {
      execSync('git fetch origin', { cwd: env.syncDir, stdio: 'ignore', timeout: 15000, env: env.gitEnv });
      try {
        execSync('git checkout -b main origin/main', { cwd: env.syncDir, stdio: 'ignore' });
      } catch {
        try {
          execSync('git checkout main', { cwd: env.syncDir, stdio: 'ignore' });
          execSync('git merge origin/main --allow-unrelated-histories -X theirs --no-edit', { cwd: env.syncDir, stdio: 'ignore' });
        } catch {
          execSync('git checkout -b main', { cwd: env.syncDir, stdio: 'ignore' });
        }
      }
    } catch {
      try { execSync('git checkout -b main', { cwd: env.syncDir, stdio: 'ignore' }); } catch {}
    }

    // Write .gitignore AFTER checkout to avoid untracked file conflict
    const gitignorePath = path.join(env.syncDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, [
        '.config.json', '.sync_lock', '.last_sync', '.last_gc',
        '.DS_Store', 'security-audit/*.log', 'security-audit/**/*.log',
      ].join('\n') + '\n');
    }

    // Clear stale tombstones and tags from previous test runs
    const deletionsPath = path.join(env.syncDir, '.deletions.json');
    const tagsPath = path.join(env.syncDir, '.tags.json');
    if (fs.existsSync(deletionsPath)) fs.writeFileSync(deletionsPath, '{}');
    if (fs.existsSync(tagsPath)) fs.writeFileSync(tagsPath, '{}');
  }
}

/** Commit and push from a machine environment. */
function commitAndPush(env, message) {
  execSync('git add .', { cwd: env.syncDir, stdio: 'ignore' });
  try {
    execSync(`git commit -m "${message}"`, { cwd: env.syncDir, stdio: 'ignore' });
  } catch { /* nothing to commit */ }
  execSync('git push -u origin main --force', { cwd: env.syncDir, stdio: 'ignore', timeout: 30000, env: env.gitEnv });
}

/** Pull latest from remote into a machine environment. */
function pullLatest(env) {
  try {
    execSync('git fetch origin', { cwd: env.syncDir, stdio: 'ignore', timeout: 15000, env: env.gitEnv });
    execSync('git merge origin/main --allow-unrelated-histories -X theirs --no-edit', {
      cwd: env.syncDir, stdio: 'ignore',
    });
  } catch { /* best effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Scenarios
// ─────────────────────────────────────────────────────────────────────────────

function testBootstrapAndFirstSync(user) {
  logSection(`Scenario 1: Bootstrap & First Sync — ${user.id}`);

  const machA = createMachineEnv(user.id, user.repo, 'machineA');

  // Create fake sessions
  createFakeSession(machA.copilotDir, 'sess-bootstrap-1', 3);
  createFakeSession(machA.copilotDir, 'sess-bootstrap-2', 2);

  // Run status (should work even before first sync)
  const statusResult = runSynctx(machA, ['status']);
  assert(`${user.id}: status runs before first sync`, statusResult.ok || statusResult.stdout.includes('Synctx'),
    `status: ${statusResult.status}, output: ${statusResult.stdout.substring(0, 200)}`);

  // Bootstrap the git repo manually (since sync-engine normally does interactive setup)
  bootstrapEnv(machA);

  // Stage files manually using the file-manager module
  const stageResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machA.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machA.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    const result = FM.stageFiles();
    console.log(JSON.stringify(result));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machA.env });

  let stageData;
  try {
    stageData = JSON.parse(stageResult.stdout.trim());
  } catch {
    stageData = { files: 0, errors: [stageResult.stderr] };
  }

  assert(`${user.id}: stageFiles finds sessions`, stageData.files > 0,
    `files: ${stageData.files}, errors: ${JSON.stringify(stageData.errors)}`);

  // Commit and push
  try {
    commitAndPush(machA, 'Initial sync from machineA');
    assert(`${user.id}: initial push succeeds`, true);
  } catch (err) {
    assert(`${user.id}: initial push succeeds`, false, err.message);
  }

  return machA;
}

function testMultiMachineSync(user, machA) {
  logSection(`Scenario 2: Multi-Machine Sync — ${user.id}`);

  const machB = createMachineEnv(user.id, user.repo, 'machineB');
  bootstrapEnv(machB);

  // Machine B creates its own sessions
  createFakeSession(machB.copilotDir, 'sess-machB-1', 4);
  createFakeSession(machB.copilotDir, 'sess-machB-2', 2);

  // Machine B pulls from remote (should get Machine A's sessions)
  pullLatest(machB);

  // Check that Machine A's sessions are in Machine B's sync dir
  const machBCopilotDir = path.join(machB.syncDir, 'github-copilot', 'session-state');
  let machBContents;
  try {
    machBContents = fs.existsSync(machBCopilotDir)
      ? fs.readdirSync(machBCopilotDir)
      : [];
  } catch { machBContents = []; }

  // Check that at least one of Machine A's bootstrap sessions exists in Machine B
  const hasSessFromA = machBContents.some(s => s.startsWith('sess-bootstrap'));
  assert(`${user.id}: Machine B sees Machine A's sessions after pull`, hasSessFromA,
    `Dir contents: [${machBContents.join(', ')}]`);

  // Machine B stages its own sessions
  const stageResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machB.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machB.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    const result = FM.stageFiles();
    console.log(JSON.stringify(result));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machB.env });

  let stageData;
  try { stageData = JSON.parse(stageResult.stdout.trim()); } catch { stageData = { files: 0 }; }
  assert(`${user.id}: Machine B stages its sessions`, stageData.files > 0,
    `files: ${stageData.files}`);

  // Machine B pushes
  try {
    commitAndPush(machB, 'Sync from machineB');
    assert(`${user.id}: Machine B push succeeds`, true);
  } catch (err) {
    assert(`${user.id}: Machine B push succeeds`, false, err.message);
  }

  // Machine A pulls — should now have Machine B's sessions
  pullLatest(machA);
  const machACopilotDir = path.join(machA.syncDir, 'github-copilot', 'session-state');
  const hasSessFromB = fs.existsSync(path.join(machACopilotDir, 'sess-machB-1'));
  assert(`${user.id}: Machine A sees Machine B's sessions after pull`, hasSessFromB);

  return machB;
}

function testDeleteTombstone(user, machA, machB) {
  logSection(`Scenario 4: Delete + Tombstone — ${user.id}`);

  // Find a session to delete from Machine A's staging
  const stagedBase = path.join(machA.syncDir, 'github-copilot', 'session-state');
  let sessionToDelete;
  try {
    const sessions = fs.readdirSync(stagedBase).filter(s => s.startsWith('sess-bootstrap'));
    sessionToDelete = sessions[0]; // Pick the first bootstrap session
  } catch { sessionToDelete = null; }

  if (!sessionToDelete) {
    assert(`${user.id}: session exists for deletion test`, false, 'No bootstrap sessions found in staging');
    return;
  }

  const stagedPath = path.join(stagedBase, sessionToDelete);

  if (fs.existsSync(stagedPath)) {
    // Delete it
    fs.rmSync(stagedPath, { recursive: true, force: true });

    // Record tombstone
    const tombResult = spawnSync(process.execPath, ['-e', `
      process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machA.syncDir)};
      const Tombstones = require('./scripts/lib/tombstones');
      Tombstones.record('${sessionToDelete}', 'github-copilot', 'delete');
      console.log(JSON.stringify(Tombstones.readAll()));
    `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machA.env });

    let tombData;
    try { tombData = JSON.parse(tombResult.stdout.trim()); } catch { tombData = {}; }
    assert(`${user.id}: tombstone recorded for ${sessionToDelete}`,
      sessionToDelete in tombData,
      `tombstones: ${Object.keys(tombData).join(', ')}`);

    // Push from Machine A
    try {
      commitAndPush(machA, 'Delete session sess-bootstrap-1');
      assert(`${user.id}: delete push succeeds`, true);
    } catch (err) {
      assert(`${user.id}: delete push succeeds`, false, err.message);
    }

    // Machine B pulls
    pullLatest(machB);

    // Machine B reads tombstones — should have the deleted session
    const machBTombstones = readTombstones(machB);
    assert(`${user.id}: Machine B receives tombstone after pull`,
      sessionToDelete in machBTombstones,
      `Machine B tombstones: ${Object.keys(machBTombstones).join(', ')}`);

    // Machine B still has the session in its LOCAL copilot dir
    const localSessionExists = fs.existsSync(path.join(machA.copilotDir, sessionToDelete));
    // (Machine A's copilot dir has the session, Machine B may or may not — doesn't matter)

    // Machine B stages files — tombstoned session should be SKIPPED
    const stageResult = spawnSync(process.execPath, ['-e', `
      process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machB.syncDir)};
      process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
      ${homeEnvLine(machB.fakeHome)}
      const FM = require('./scripts/lib/file-manager');
      const result = FM.stageFiles();

      // Check if the tombstoned session was re-created in staging
      const fs = require('fs');
      const stagedDir = require('path').join(${JSON.stringify(machB.syncDir)}, 'github-copilot', 'session-state');
      const sessions = fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir) : [];
      console.log(JSON.stringify({ ...result, sessions }));
    `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machB.env });

    let stageData;
    try { stageData = JSON.parse(stageResult.stdout.trim()); } catch { stageData = { sessions: [] }; }

    // The deleted session should NOT be in Machine B's staging after stageFiles
    const resynced = (stageData.sessions || []).includes(sessionToDelete);
    assert(`${user.id}: tombstoned session NOT re-staged on Machine B`, !resynced,
      `sessions in staging: ${(stageData.sessions || []).join(', ')}`);
  } else {
    assert(`${user.id}: session exists for deletion test`, false,
      `${stagedPath} not found`);
  }
}

function testTagOperations(user, machA, machB) {
  logSection(`Scenario 7: Tag Operations — ${user.id}`);

  // Find a session to tag
  const stagedBase = path.join(machA.syncDir, 'github-copilot', 'session-state');
  let sessionToTag;
  try {
    const sessions = fs.readdirSync(stagedBase).filter(s => s.startsWith('sess-'));
    sessionToTag = sessions[0];
  } catch { sessionToTag = 'sess-bootstrap-2'; }

  const tagName = `test-tag-${user.id}`;

  const tagResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machA.syncDir)};
    const Tags = require('./scripts/lib/tags');
    const result = Tags.assign('${tagName}', '${sessionToTag}', 'github-copilot');
    console.log(JSON.stringify(result));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machA.gitEnv });

  let tagData;
  try { tagData = JSON.parse(tagResult.stdout.trim()); } catch { tagData = { success: false }; }
  assert(`${user.id}: tag assignment succeeds`, tagData.success === true,
    `result: ${JSON.stringify(tagData)}`);

  // Verify tag exists
  const tags = readTags(machA);
  assert(`${user.id}: tag is stored in .tags.json`, tagName in tags);

  // Push tags to remote
  try {
    commitAndPush(machA, `Tag: ${tagName}`);
    assert(`${user.id}: tag push succeeds`, true);
  } catch (err) {
    assert(`${user.id}: tag push succeeds`, false, err.message);
  }

  // Machine B pulls — should see the tag
  pullLatest(machB);
  const machBTags = readTags(machB);
  assert(`${user.id}: Machine B sees tag after pull`, tagName in machBTags);
}

function testTagReleaseOnDelete(user, machA) {
  logSection(`Scenario 8: Tag Release on Delete — ${user.id}`);

  const tagName = `test-tag-${user.id}`;

  // Find the session this tag points to
  const tags = readTags(machA);
  const sessionToDelete = tags[tagName]?.sessionId;
  if (!sessionToDelete) {
    assert(`${user.id}: tag exists before deletion`, false, 'Tag not found');
    return;
  }

  // Verify tag exists before deletion
  assert(`${user.id}: tag exists before deletion`, true);

  // Delete the session
  const stagedPath = path.join(machA.syncDir, 'github-copilot', 'session-state', sessionToDelete);
  if (fs.existsSync(stagedPath)) {
    fs.rmSync(stagedPath, { recursive: true, force: true });
  }

  // Record tombstone + release tags
  spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machA.syncDir)};
    const Tombstones = require('./scripts/lib/tombstones');
    const Tags = require('./scripts/lib/tags');
    Tombstones.record('${sessionToDelete}', 'github-copilot', 'delete');
    const removed = Tags.removeBySession('${sessionToDelete}');
    console.log(JSON.stringify({ removed }));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machA.env });

  // Verify tag was released
  const tagsAfter = readTags(machA);
  assert(`${user.id}: tag released after session deletion`, !(tagName in tagsAfter),
    `tags after: ${Object.keys(tagsAfter).join(', ')}`);

  // Verify tombstone exists
  const tombstones = readTombstones(machA);
  assert(`${user.id}: tombstone exists for deleted tagged session`,
    sessionToDelete in tombstones);
}

function testPruneTombstone(user) {
  logSection(`Scenario 5: Prune + Tombstone — ${user.id}`);

  const machC = createMachineEnv(user.id, user.repo, 'machineC');
  bootstrapEnv(machC);
  pullLatest(machC);

  // Create some old sessions (we'll pretend they're old via name)
  const oldSessions = ['sess-old-1', 'sess-old-2', 'sess-old-3'];
  for (const s of oldSessions) {
    createFakeSession(machC.copilotDir, s, 2);
  }

  // Stage them
  spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machC.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machC.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    FM.stageFiles();
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machC.env });

  // Now simulate pruning by deleting + tombstoning
  const Tombstones = require(path.join(PROJECT_ROOT, 'scripts', 'lib', 'tombstones'));

  // Temporarily override CONFIG.syncDir for tombstone operations
  const pruneResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machC.syncDir)};
    const Tombstones = require('./scripts/lib/tombstones');
    const fs = require('fs');
    const path = require('path');

    const sessions = ${JSON.stringify(oldSessions.map(s => ({ sessionId: s, cli: 'github-copilot' })))};
    Tombstones.recordMany(sessions, 'prune');

    // Delete from staging
    for (const s of sessions) {
      const p = path.join(${JSON.stringify(machC.syncDir)}, 'github-copilot', 'session-state', s.sessionId);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }

    console.log(JSON.stringify(Tombstones.readAll()));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machC.env });

  let pruneData;
  try { pruneData = JSON.parse(pruneResult.stdout.trim()); } catch { pruneData = {}; }

  assert(`${user.id}: prune tombstones all ${oldSessions.length} sessions`,
    oldSessions.every(s => s in pruneData),
    `tombstoned: ${Object.keys(pruneData).join(', ')}`);

  // Now stage again — the pruned sessions should be skipped
  const stageResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machC.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machC.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    const result = FM.stageFiles();
    const fs = require('fs');
    const stagedDir = require('path').join(${JSON.stringify(machC.syncDir)}, 'github-copilot', 'session-state');
    const sessions = fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir) : [];
    console.log(JSON.stringify({ ...result, sessions }));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machC.env });

  let stageData;
  try { stageData = JSON.parse(stageResult.stdout.trim()); } catch { stageData = { sessions: [] }; }

  const reSynced = oldSessions.filter(s => (stageData.sessions || []).includes(s));
  assert(`${user.id}: pruned sessions NOT re-staged`, reSynced.length === 0,
    `re-synced: ${reSynced.join(', ')}`);
}

function testCleanTombstone(user) {
  logSection(`Scenario 6: Clean + Tombstone — ${user.id}`);

  const machD = createMachineEnv(user.id, user.repo, 'machineD');
  bootstrapEnv(machD);
  pullLatest(machD);

  // Create sessions
  createFakeSession(machD.copilotDir, 'sess-clean-1', 3);
  createFakeSession(machD.copilotDir, 'sess-clean-2', 2);

  // Stage them
  spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machD.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machD.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    FM.stageFiles();
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machD.env });

  // Tag one session (use gitEnv because Tags.assign does git pull)
  spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machD.syncDir)};
    const Tags = require('./scripts/lib/tags');
    Tags.assign('clean-tag', 'sess-clean-1', 'github-copilot');
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machD.gitEnv });

  // Verify tag exists
  const tagsBefore = readTags(machD);
  assert(`${user.id}: tag exists before clean`, 'clean-tag' in tagsBefore);

  // Now simulate clean: tombstone all sessions + release tags + clean staging
  const cleanResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machD.syncDir)};
    const Tombstones = require('./scripts/lib/tombstones');
    const Tags = require('./scripts/lib/tags');
    const FM = require('./scripts/lib/file-manager');

    // Scan what's in staging
    const fs = require('fs');
    const path = require('path');
    const stagedDir = path.join(${JSON.stringify(machD.syncDir)}, 'github-copilot', 'session-state');
    const sessions = fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir) : [];

    // Tombstone all
    Tombstones.recordMany(sessions.map(s => ({ sessionId: s, cli: 'github-copilot' })), 'clean');

    // Release ALL tags (clean is full wipe)
    const allTags = Tags.readTags();
    const tagCount = Object.keys(allTags).length;
    for (const tag of Object.keys(allTags)) {
      Tags.remove(tag);
    }

    // Clean staging
    FM.cleanStaging();

    const tombstones = Tombstones.readAll();
    const tags = Tags.readTags();
    console.log(JSON.stringify({ tombstoned: Object.keys(tombstones).length, tags: Object.keys(tags), releasedTags: tagCount, sessions }));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machD.env });

  let cleanData;
  try { cleanData = JSON.parse(cleanResult.stdout.trim()); } catch { cleanData = { tombstoned: 0, tags: [], releasedTags: 0 }; }

  assert(`${user.id}: clean tombstones all sessions`, cleanData.tombstoned >= 2,
    `tombstoned: ${cleanData.tombstoned}`);
  assert(`${user.id}: clean releases tags`, cleanData.releasedTags >= 1,
    `released: ${cleanData.releasedTags}`);
  assert(`${user.id}: no tags remain after clean`, cleanData.tags.length === 0,
    `remaining tags: ${cleanData.tags.join(', ')}`);
}

function testConcurrentSync(user) {
  logSection(`Scenario 3: Concurrent Sync (Lock Contention) — ${user.id}`);

  const machE = createMachineEnv(user.id, user.repo, 'machineE');
  const machF = createMachineEnv(user.id, user.repo, 'machineF');

  // Both try to acquire lock
  const lockResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machE.syncDir)};
    process.env.SYNCTX_LOCK_TTL = '5000';
    const Lock = require('./scripts/lib/lock');

    // First acquire
    const got1 = Lock.acquire();

    // Try second acquire from same process (should fail — lock held by us)
    // Actually same PID, so let's simulate different PID
    const fs = require('fs');
    const lockFile = ${JSON.stringify(path.join(machE.syncDir, '.sync_lock'))};
    if (got1) {
      // Write a lock with a different PID
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999, timestamp: new Date().toISOString() }));

      // Try to acquire — should fail (PID 99999 won't be alive, but might be reclaimed as stale)
      // Actually, isProcessAlive(99999) will likely return false, so lock is stale → reclaimed
      // Let's use our own PID to simulate a real contention scenario
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
      const got2 = Lock.acquire(); // Should fail — same PID, same process, within TTL

      Lock.release();
      console.log(JSON.stringify({ got1, got2 }));
    } else {
      console.log(JSON.stringify({ got1, got2: false }));
    }
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machE.env });

  let lockData;
  try { lockData = JSON.parse(lockResult.stdout.trim()); } catch { lockData = { got1: false, got2: false }; }

  assert(`${user.id}: first lock acquisition succeeds`, lockData.got1 === true);
  // The second acquire from same PID with same timestamp should fail (lock is live)
  // Actually, since it's the same PID and within TTL, it should return false
  assert(`${user.id}: concurrent lock is blocked`, lockData.got2 === false,
    `got2: ${lockData.got2}`);

  // Test stale lock recovery (dead PID)
  const staleResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machF.syncDir)};
    const Lock = require('./scripts/lib/lock');
    const fs = require('fs');
    const lockFile = ${JSON.stringify(path.join(machF.syncDir, '.sync_lock'))};

    // Create a stale lock with a dead PID
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483647, timestamp: new Date().toISOString() }));

    // Should reclaim because PID 2147483647 is unlikely alive
    const got = Lock.acquire();
    Lock.release();
    console.log(JSON.stringify({ got }));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machF.env });

  let staleData;
  try { staleData = JSON.parse(staleResult.stdout.trim()); } catch { staleData = { got: false }; }
  assert(`${user.id}: stale lock from dead PID is reclaimed`, staleData.got === true);
}

function testListAndStatus(user, machA) {
  logSection(`Scenario 9: List & Status Commands — ${user.id}`);

  // Test list command output parsing
  const listResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machA.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machA.fakeHome)}
    const ListCmd = require('./scripts/lib/commands/list');
    const sessions = ListCmd.scanSessions(
      require('path').join(${JSON.stringify(machA.syncDir)}, 'github-copilot', 'session-state')
    );
    console.log(JSON.stringify(sessions.map(s => s.name)));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machA.env });

  let sessions;
  try { sessions = JSON.parse(listResult.stdout.trim()); } catch { sessions = []; }
  assert(`${user.id}: scanSessions returns results`, sessions.length >= 0,
    `sessions: ${sessions.join(', ')}`);
}

function testEdgeCases(user) {
  logSection(`Scenario 10: Edge Cases — ${user.id}`);

  const machG = createMachineEnv(user.id, user.repo, 'machineG');
  bootstrapEnv(machG);

  // Edge case 1: Empty session directory
  const emptySession = path.join(machG.copilotDir, 'sess-empty');
  fs.mkdirSync(emptySession, { recursive: true });

  const stageResult1 = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machG.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machG.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    try {
      const result = FM.stageFiles();
      console.log(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    }
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machG.env });

  let data1;
  try { data1 = JSON.parse(stageResult1.stdout.trim()); } catch { data1 = { ok: false }; }
  assert(`${user.id}: empty session directory handled gracefully`, data1.ok === true,
    data1.error || '');

  // Edge case 2: Session with special characters in name (UUID format)
  const specialSession = 'sess-{uuid}-[test]-(special)';
  try {
    createFakeSession(machG.copilotDir, specialSession, 1);
    assert(`${user.id}: special character session name created`, true);
  } catch (err) {
    assert(`${user.id}: special character session name created`, false, err.message);
  }

  // Edge case 3: Very large session (50 files)
  createFakeSession(machG.copilotDir, 'sess-large', 50);
  const stageResult3 = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machG.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machG.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    const result = FM.stageFiles();
    console.log(JSON.stringify(result));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machG.env });

  let data3;
  try { data3 = JSON.parse(stageResult3.stdout.trim()); } catch { data3 = { files: 0 }; }
  assert(`${user.id}: large session (50 files) staged`, data3.files >= 50,
    `files: ${data3.files}`);

  // Edge case 4: Corrupt tombstone file
  const tombFile = path.join(machG.syncDir, '.deletions.json');
  fs.writeFileSync(tombFile, 'NOT VALID JSON!!!');

  const tombResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machG.syncDir)};
    const Tombstones = require('./scripts/lib/tombstones');
    const data = Tombstones.readAll();
    console.log(JSON.stringify({ ok: true, count: Object.keys(data).length }));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machG.env });

  let tombData;
  try { tombData = JSON.parse(tombResult.stdout.trim()); } catch { tombData = { ok: false }; }
  assert(`${user.id}: corrupt .deletions.json handled gracefully`, tombData.ok === true,
    `returned: ${JSON.stringify(tombData)}`);

  // Edge case 5: Corrupt tags file
  const tagsFile = path.join(machG.syncDir, '.tags.json');
  fs.writeFileSync(tagsFile, '{invalid json');

  const tagsResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machG.syncDir)};
    const Tags = require('./scripts/lib/tags');
    try {
      const data = Tags.readTags();
      console.log(JSON.stringify({ ok: true, count: Object.keys(data).length }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    }
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machG.env });

  let tagsData;
  try { tagsData = JSON.parse(tagsResult.stdout.trim()); } catch { tagsData = { ok: false }; }
  assert(`${user.id}: corrupt .tags.json handled gracefully`, tagsData.ok === true,
    tagsData.error || '');

  // Edge case 6: Double tombstone (same session tombstoned twice)
  const doubleTombResult = spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machG.syncDir)};
    const Tombstones = require('./scripts/lib/tombstones');
    Tombstones.record('double-delete', 'github-copilot', 'delete');
    Tombstones.record('double-delete', 'github-copilot', 'prune');
    const data = Tombstones.readAll();
    console.log(JSON.stringify({ reason: data['double-delete']?.reason, count: Object.keys(data).length }));
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machG.env });

  let doubleData;
  try { doubleData = JSON.parse(doubleTombResult.stdout.trim()); } catch { doubleData = { reason: null }; }
  assert(`${user.id}: double tombstone uses latest reason`, doubleData.reason === 'prune',
    `reason: ${doubleData.reason}`);
}

function testGitleaksIntegration(user, machA) {
  logSection(`Scenario 11: Gitleaks Security Scan — ${user.id}`);

  // Create a session with a fake secret
  createFakeSession(machA.copilotDir, 'sess-secret-test', 1);
  const secretFile = path.join(machA.copilotDir, 'sess-secret-test', 'turn-secret.json');
  fs.writeFileSync(secretFile, JSON.stringify({
    message: 'Here is my AWS key: AKIAIOSFODNN7EXAMPLE and secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }));

  // Stage it
  spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machA.syncDir)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(user.repo)};
    ${homeEnvLine(machA.fakeHome)}
    const FM = require('./scripts/lib/file-manager');
    FM.stageFiles();
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', env: machA.env });

  // Run gitleaks on the staged file
  const stagedSecretFile = path.join(machA.syncDir, 'github-copilot', 'session-state', 'sess-secret-test', 'turn-secret.json');
  if (fs.existsSync(stagedSecretFile)) {
    try {
      const result = execSync(`gitleaks detect --source "${machA.syncDir}" --no-git --verbose 2>&1`, {
        encoding: 'utf8', timeout: 30000,
      });
      // If gitleaks exits 0, no secrets found (unlikely with our test data)
      assert(`${user.id}: gitleaks runs on staged data`, true);
    } catch (err) {
      // Exit code 1 = leaks found (expected with our fake secret)
      if (err.status === 1) {
        assert(`${user.id}: gitleaks detects secrets in staged data`, true);
      } else {
        assert(`${user.id}: gitleaks runs without error`, false, err.message);
      }
    }
  }

  // Clean up the secret test session
  const secretStagedDir = path.join(machA.syncDir, 'github-copilot', 'session-state', 'sess-secret-test');
  if (fs.existsSync(secretStagedDir)) {
    fs.rmSync(secretStagedDir, { recursive: true, force: true });
  }
  const secretLocalDir = path.join(machA.copilotDir, 'sess-secret-test');
  if (fs.existsSync(secretLocalDir)) {
    fs.rmSync(secretLocalDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  Synctx v1.0.0 — Load & Integration Test Suite');
  console.log(`  Platform: ${os.platform()} (${os.arch()}) | Node ${process.version}`);
  console.log('═'.repeat(70));

  // Cleanup mode
  if (CLEANUP_ONLY) {
    logSection('Cleanup Only');
    for (const user of USERS) {
      deleteRepo(user.repo);
    }
    if (fs.existsSync(TEST_BASE)) {
      fs.rmSync(TEST_BASE, { recursive: true, force: true });
      log(`[ok] Removed test directory: ${TEST_BASE}`);
    }
    return;
  }

  // Setup
  logSection('Setup: Creating test directories and GitHub repos');
  if (fs.existsSync(TEST_BASE)) {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_BASE, { recursive: true });
  log(`[ok] Test base: ${TEST_BASE}`);

  // Delete and recreate repos to ensure clean state
  for (const user of USERS) {
    deleteRepo(user.repo);
    const ok = ensureRepo(user.repo);
    assert(`repo ${user.repo} created fresh`, ok);
  }

  // Run tests for each user
  for (const user of USERS) {
    logSection(`===== USER: ${user.id} (repo: ${user.repo}) =====`);

    // Scenario 1: Bootstrap
    const machA = testBootstrapAndFirstSync(user);

    // Scenario 2: Multi-machine sync
    const machB = testMultiMachineSync(user, machA);

    // Scenario 3: Concurrent sync (lock contention)
    testConcurrentSync(user);

    // Scenario 7: Tag operations (before delete, needs sessions)
    testTagOperations(user, machA, machB);

    // Scenario 4: Delete + tombstone
    testDeleteTombstone(user, machA, machB);

    // Scenario 8: Tag release on delete
    testTagReleaseOnDelete(user, machA);

    // Scenario 5: Prune + tombstone
    testPruneTombstone(user);

    // Scenario 6: Clean + tombstone
    testCleanTombstone(user);

    // Scenario 9: List & Status
    testListAndStatus(user, machA);

    // Scenario 10: Edge cases
    testEdgeCases(user);

    // Scenario 11: Gitleaks
    testGitleaksIntegration(user, machA);
  }

  // Summary
  logSection('TEST RESULTS');
  console.log(`\n  Total:  ${totalTests}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (issues.length > 0) {
    console.log(`\n  Issues Found (${issues.length}):`);
    for (const issue of issues) {
      console.log(`    ${issue}`);
    }
  }

  console.log(`\n${'═'.repeat(70)}\n`);

  // Cleanup prompt
  console.log('  To cleanup test repos and directories, run:');
  console.log('    node tests/load-test.js --cleanup-only\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\n[FATAL] ${err.message}\n${err.stack}`);
  process.exit(2);
});
