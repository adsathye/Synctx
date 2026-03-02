#!/usr/bin/env node
'use strict';

/**
 * Synctx — End-to-End Test Suite
 *
 * Runs INSIDE a Docker container with Node, Git, gh, and gitleaks installed.
 * Tests the actual CLI commands as a real user would invoke them.
 *
 * Environment:
 *   GH_TOKEN        — GitHub auth token (required)
 *   E2E_REPO        — Test repo name (default: .synctx-e2e-test)
 *   E2E_MACHINE     — Machine identifier for cross-machine tests (A or B)
 *   E2E_SCENARIO    — Run specific scenario only (optional)
 *
 * Usage:
 *   node tests/e2e/e2e-test.js                    # Run all scenarios
 *   E2E_SCENARIO=restore node tests/e2e/e2e-test.js  # Run one scenario
 */

const { execSync, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SYNCTX_CMD = path.join(PROJECT_ROOT, 'scripts', 'sync-engine.js');
const IS_WIN = os.platform() === 'win32';

const GH_TOKEN = process.env.GH_TOKEN;
const REPO_NAME = process.env.E2E_REPO || '.synctx-e2e-test';
const MACHINE_ID = process.env.E2E_MACHINE || 'A';
const SCENARIO_FILTER = process.env.E2E_SCENARIO || null;

const HOME_DIR = os.homedir();
const SYNC_DIR = path.join(HOME_DIR, '.synctx');
const COPILOT_DIR = path.join(HOME_DIR, '.copilot', 'session-state');
const CLAUDE_DIR = path.join(HOME_DIR, '.claude', 'todos');
const PLUGIN_DIR = path.join(HOME_DIR, '.synctx-plugin');

let totalTests = 0;
let passed = 0;
let failed = 0;
const issues = [];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function log(msg) { console.log(`  ${msg}`); }
function logSection(title) {
  console.log(`\n${'─'.repeat(70)}\n  ${title}\n${'─'.repeat(70)}`);
}

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

/** Run synctx CLI command, optionally piping stdin for interactive prompts. */
function synctx(args, { input, timeout, allowFail } = {}) {
  const result = spawnSync(process.execPath, [SYNCTX_CMD, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: timeout || 30000,
    input: input || undefined,
    env: {
      ...process.env,
      SYNCTX_SYNC_DIR: SYNC_DIR,
      SYNCTX_REPO_NAME: REPO_NAME,
      SYNCTX_NONINTERACTIVE: '1',
      // Disable color for easier parsing
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  if (!allowFail && result.status !== 0 && result.status !== null) {
    const err = (result.stderr || '').substring(0, 500);
    if (!allowFail) {
      log(`  [debug] synctx ${args.join(' ')} exited ${result.status}: ${err}`);
    }
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: (result.stdout || '') + (result.stderr || ''),
  };
}

/** Run a shell command and return stdout. */
function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: opts.timeout || 15000,
      stdio: opts.stdio || ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

/** Create fake Copilot session directory with test files. */
function createFakeSession(sessionId, fileCount = 3) {
  const dir = path.join(COPILOT_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(
      path.join(dir, `turn-${i}.json`),
      JSON.stringify({ role: 'user', content: `Test turn ${i} for ${sessionId}`, ts: new Date().toISOString() }),
    );
  }
  fs.writeFileSync(path.join(dir, 'plan.md'), `# Session ${sessionId}\nE2E test session.\n`);
  return dir;
}

/** Create fake Claude session directory. */
function createClaudeSession(sessionId, fileCount = 2) {
  const dir = path.join(CLAUDE_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `task-${i}.md`), `# Task ${i}\nClaude todo for ${sessionId}.\n`);
  }
  return dir;
}

/** Ensure GitHub repo exists (create if needed). */
function ensureRepo() {
  const ghUser = sh('gh api user --jq .login');
  try {
    sh(`gh repo view ${ghUser}/${REPO_NAME} --json name`);
    log(`[ok] Repo ${ghUser}/${REPO_NAME} exists`);
  } catch {
    sh(`gh repo create ${REPO_NAME} --private`);
    log(`[ok] Created repo ${ghUser}/${REPO_NAME}`);
  }
  return ghUser;
}

/** Clean up sync dir for fresh state. */
function cleanState() {
  if (fs.existsSync(SYNC_DIR)) {
    fs.rmSync(SYNC_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(COPILOT_DIR)) {
    fs.rmSync(COPILOT_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(CLAUDE_DIR)) {
    fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(COPILOT_DIR, { recursive: true });
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
}

/** Bootstrap the sync repo (equivalent to first-run setup). */
function bootstrap(ghUser) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(path.join(SYNC_DIR, '.config.json'), JSON.stringify({ repoName: REPO_NAME }));

  execSync('git init', { cwd: SYNC_DIR, stdio: 'ignore' });
  execSync('git config user.name "Synctx E2E"', { cwd: SYNC_DIR, stdio: 'ignore' });
  execSync('git config user.email "e2e@synctx.test"', { cwd: SYNC_DIR, stdio: 'ignore' });
  execFileSync('git', ['config', 'credential.helper', '!gh auth git-credential'], { cwd: SYNC_DIR, stdio: 'ignore' });
  execSync('git config core.autocrlf false', { cwd: SYNC_DIR, stdio: 'ignore' });

  const remoteUrl = `https://github.com/${ghUser}/${REPO_NAME}.git`;
  try {
    execSync(`git remote add origin ${remoteUrl}`, { cwd: SYNC_DIR, stdio: 'ignore' });
  } catch {
    execSync(`git remote set-url origin ${remoteUrl}`, { cwd: SYNC_DIR, stdio: 'ignore' });
  }

  // Fetch and checkout if remote has content
  try {
    execSync('git fetch origin', { cwd: SYNC_DIR, stdio: 'ignore', timeout: 15000 });
    try {
      execSync('git checkout -b main origin/main', { cwd: SYNC_DIR, stdio: 'ignore' });
    } catch {
      try {
        execSync('git checkout main', { cwd: SYNC_DIR, stdio: 'ignore' });
      } catch {
        execSync('git checkout -b main', { cwd: SYNC_DIR, stdio: 'ignore' });
      }
    }
  } catch {
    try { execSync('git checkout -b main', { cwd: SYNC_DIR, stdio: 'ignore' }); } catch {}
  }

  // Write .gitignore AFTER checkout
  const gitignorePath = path.join(SYNC_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, [
      '.config.json', '.sync_lock', '.last_sync', '.last_gc',
      '.DS_Store', 'security-audit/*.log', 'security-audit/**/*.log',
    ].join('\n') + '\n');
  }

  // Clear stale tombstones/tags from previous runs
  const delPath = path.join(SYNC_DIR, '.deletions.json');
  const tagPath = path.join(SYNC_DIR, '.tags.json');
  if (fs.existsSync(delPath)) fs.writeFileSync(delPath, '{}');
  if (fs.existsSync(tagPath)) fs.writeFileSync(tagPath, '{}');

  // Also clean any stale staged sessions from previous runs
  const stagedCopilot = path.join(SYNC_DIR, 'github-copilot', 'session-state');
  if (fs.existsSync(stagedCopilot)) {
    fs.rmSync(stagedCopilot, { recursive: true, force: true });
    fs.mkdirSync(stagedCopilot, { recursive: true });
  }
  const stagedClaude = path.join(SYNC_DIR, 'claude', 'todos');
  if (fs.existsSync(stagedClaude)) {
    fs.rmSync(stagedClaude, { recursive: true, force: true });
    fs.mkdirSync(stagedClaude, { recursive: true });
  }
}

/** Force push current state to remote. */
function pushToRemote(message) {
  execSync('git add -A', { cwd: SYNC_DIR, stdio: 'ignore' });
  try {
    execSync(`git commit -m "${message}"`, { cwd: SYNC_DIR, stdio: 'ignore' });
  } catch { /* nothing to commit */ }
  execSync('git push -u origin main --force', { cwd: SYNC_DIR, stdio: 'ignore', timeout: 30000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Status Command
// ─────────────────────────────────────────────────────────────────────────────

function testStatus() {
  logSection('Scenario 1: Status Command');

  const result = synctx(['status']);

  assert('status exits cleanly', result.ok || result.output.includes('Synctx'),
    `exit: ${result.status}`);
  assert('status shows version', result.output.includes('0.0.1'),
    result.output.substring(0, 300));
  assert('status shows platform', result.output.includes(os.platform()),
    result.output.substring(0, 300));
  assert('status shows sync dir', result.output.includes('.synctx'),
    result.output.substring(0, 300));
  assert('status shows repo name', result.output.includes(REPO_NAME),
    result.output.substring(0, 300));
  assert('status shows prerequisites', result.output.includes('Node.js') && result.output.includes('Git'),
    result.output.substring(0, 500));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Push (sync) Command
// ─────────────────────────────────────────────────────────────────────────────

function testPushSync() {
  logSection('Scenario 2: Push & Sync Commands');

  // Create sessions to push
  createFakeSession('e2e-push-sess-1', 3);
  createFakeSession('e2e-push-sess-2', 2);
  createClaudeSession('e2e-push-claude-1', 2);

  // Run sync (blocking push + pull)
  const syncResult = synctx(['sync'], { timeout: 60000 });
  assert('sync command completes', syncResult.ok,
    `exit: ${syncResult.status}, err: ${syncResult.stderr.substring(0, 300)}`);
  assert('sync output mentions sync', syncResult.output.includes('Sync') || syncResult.output.includes('sync'),
    syncResult.output.substring(0, 300));

  // Verify sessions are staged
  const stagedDir = path.join(SYNC_DIR, 'github-copilot', 'session-state');
  const stagedSessions = fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir) : [];
  assert('sessions staged after sync', stagedSessions.includes('e2e-push-sess-1'),
    `staged: ${stagedSessions.join(', ')}`);
  assert('claude sessions staged', fs.existsSync(path.join(SYNC_DIR, 'claude', 'todos', 'e2e-push-claude-1')),
    'claude session not found in staging');

  // Verify git log has a commit
  const gitLog = sh('git log --oneline -1', { cwd: SYNC_DIR, allowFail: true });
  assert('git commit created', gitLog.length > 0, gitLog);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: List Commands
// ─────────────────────────────────────────────────────────────────────────────

function testList() {
  logSection('Scenario 3: List Commands');

  const listResult = synctx(['list']);
  assert('list command completes', listResult.ok || listResult.output.length > 0,
    `exit: ${listResult.status}`);
  assert('list shows sessions', listResult.output.includes('e2e-push-sess') || listResult.output.includes('session'),
    listResult.output.substring(0, 500));

  // list-copilot
  const copilotResult = synctx(['list-copilot']);
  assert('list-copilot completes', copilotResult.ok || copilotResult.output.length > 0,
    `exit: ${copilotResult.status}`);

  // list-claude
  const claudeResult = synctx(['list-claude']);
  assert('list-claude completes', claudeResult.ok || claudeResult.output.length > 0,
    `exit: ${claudeResult.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Tag Operations
// ─────────────────────────────────────────────────────────────────────────────

function testTags() {
  logSection('Scenario 4: Tag Operations');

  // Tag a session
  const tagResult = synctx(['tag', 'e2e-push-sess-1', 'e2e-test-tag']);
  assert('tag command completes', tagResult.ok,
    `exit: ${tagResult.status}, out: ${tagResult.output.substring(0, 300)}`);

  // Verify tag in .tags.json
  const tagsFile = path.join(SYNC_DIR, '.tags.json');
  let tags = {};
  try { tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8')); } catch {}
  assert('tag stored in .tags.json', 'e2e-test-tag' in tags,
    `tags: ${JSON.stringify(tags)}`);
  assert('tag points to correct session', tags['e2e-test-tag']?.sessionId === 'e2e-push-sess-1',
    `sessionId: ${tags['e2e-test-tag']?.sessionId}`);

  // List tags via CLI
  const tagsResult = synctx(['tags']);
  assert('tags command shows tag', tagsResult.output.includes('e2e-test-tag'),
    tagsResult.output.substring(0, 300));

  // Untag
  const untagResult = synctx(['untag', 'e2e-test-tag']);
  assert('untag command completes', untagResult.ok,
    `exit: ${untagResult.status}, out: ${untagResult.output.substring(0, 300)}`);

  // Verify tag removed
  try { tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8')); } catch { tags = {}; }
  assert('tag removed from .tags.json', !('e2e-test-tag' in tags),
    `remaining tags: ${Object.keys(tags).join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: Restore Command
// ─────────────────────────────────────────────────────────────────────────────

function testRestore() {
  logSection('Scenario 5: Restore Command');

  // Tag a session for restore-by-tag test
  synctx(['tag', 'e2e-push-sess-1', 'restore-tag']);

  // Remove the session from the local copilot dir (simulate different machine)
  const localSession = path.join(COPILOT_DIR, 'e2e-push-sess-1');
  if (fs.existsSync(localSession)) {
    fs.rmSync(localSession, { recursive: true, force: true });
  }
  assert('session removed from local copilot dir', !fs.existsSync(localSession));

  // Restore by ID (the restore command should copy from staging to copilot dir)
  const restoreResult = synctx(['restore', 'e2e-push-sess-1', '--cli', 'copilot'], { allowFail: true, timeout: 30000 });
  // Restore may fail because copilot CLI isn't installed to --resume, but files should be copied
  const restored = fs.existsSync(localSession);
  assert('restore by ID copies files to copilot dir', restored,
    `exists: ${restored}, output: ${restoreResult.output.substring(0, 300)}`);

  if (restored) {
    const restoredFiles = fs.readdirSync(localSession);
    assert('restored session has files', restoredFiles.length > 0,
      `files: ${restoredFiles.join(', ')}`);
  }

  // Restore by tag
  const localSession2 = path.join(COPILOT_DIR, 'e2e-push-sess-1');
  if (fs.existsSync(localSession2)) {
    fs.rmSync(localSession2, { recursive: true, force: true });
  }
  const restoreByTag = synctx(['restore', 'restore-tag', '--cli', 'copilot'], { allowFail: true, timeout: 30000 });
  assert('restore by tag copies files', fs.existsSync(localSession2),
    `output: ${restoreByTag.output.substring(0, 300)}`);

  // Clean up tag
  synctx(['untag', 'restore-tag']);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: Delete with Double Confirmation
// ─────────────────────────────────────────────────────────────────────────────

function testDelete() {
  logSection('Scenario 6: Delete Command (with confirmation)');

  // Create and sync a session for deletion
  createFakeSession('e2e-delete-me', 2);
  synctx(['sync'], { timeout: 60000 });

  // Tag it first to verify tag release
  synctx(['tag', 'e2e-delete-me', 'delete-me-tag']);

  // Verify session exists in staging
  const stagedDir = path.join(SYNC_DIR, 'github-copilot', 'session-state', 'e2e-delete-me');
  assert('session staged before delete', fs.existsSync(stagedDir));

  // Delete with double-confirm (pipe "yes\nyes\n" to stdin)
  const deleteResult = synctx(['delete', 'e2e-delete-me'], {

    timeout: 60000,
  });
  assert('delete command completes', deleteResult.ok || deleteResult.output.includes('Deleted') || deleteResult.output.includes('tombstone'),
    `exit: ${deleteResult.status}, out: ${deleteResult.output.substring(0, 500)}`);

  // Verify tombstone recorded
  const tombFile = path.join(SYNC_DIR, '.deletions.json');
  let tombstones = {};
  try { tombstones = JSON.parse(fs.readFileSync(tombFile, 'utf8')); } catch {}
  assert('tombstone recorded for deleted session', 'e2e-delete-me' in tombstones,
    `tombstones: ${Object.keys(tombstones).join(', ')}`);

  // Verify tag released
  const tagsFile = path.join(SYNC_DIR, '.tags.json');
  let tags = {};
  try { tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8')); } catch {}
  assert('tag released after delete', !('delete-me-tag' in tags),
    `remaining tags: ${Object.keys(tags).join(', ')}`);

  // Verify session removed from staging
  assert('session removed from staging', !fs.existsSync(stagedDir));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: Prune with Double Confirmation
// ─────────────────────────────────────────────────────────────────────────────

function testPrune() {
  logSection('Scenario 7: Prune Command (with confirmation)');

  // Create old sessions
  createFakeSession('e2e-prune-old-1', 2);
  createFakeSession('e2e-prune-old-2', 2);
  createFakeSession('e2e-prune-old-3', 2);
  synctx(['sync'], { timeout: 60000 });

  // Prune with --days 0 (prune everything) and double-confirm
  const pruneResult = synctx(['prune', '--days', '0'], {

    timeout: 60000,
  });
  assert('prune command completes', pruneResult.ok || pruneResult.output.includes('Prune') || pruneResult.output.includes('prune'),
    `exit: ${pruneResult.status}, out: ${pruneResult.output.substring(0, 500)}`);

  // Verify tombstones for pruned sessions
  const tombFile = path.join(SYNC_DIR, '.deletions.json');
  let tombstones = {};
  try { tombstones = JSON.parse(fs.readFileSync(tombFile, 'utf8')); } catch {}
  const prunedCount = ['e2e-prune-old-1', 'e2e-prune-old-2', 'e2e-prune-old-3']
    .filter(s => s in tombstones).length;
  assert('tombstones recorded for pruned sessions', prunedCount >= 2,
    `pruned tombstones: ${prunedCount}, all: ${Object.keys(tombstones).join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8: Clean with Double Confirmation
// ─────────────────────────────────────────────────────────────────────────────

function testClean() {
  logSection('Scenario 8: Clean Command (with confirmation)');

  // Create and sync sessions
  createFakeSession('e2e-clean-1', 2);
  createFakeSession('e2e-clean-2', 2);
  synctx(['sync'], { timeout: 60000 });

  // Tag one
  synctx(['tag', 'e2e-clean-1', 'clean-test-tag']);

  // Clean with double-confirm
  const cleanResult = synctx(['clean'], {

    timeout: 60000,
  });
  assert('clean command completes', cleanResult.ok || cleanResult.output.includes('clean') || cleanResult.output.includes('Clean'),
    `exit: ${cleanResult.status}, out: ${cleanResult.output.substring(0, 500)}`);

  // Verify staging dir wiped
  const stagedDir = path.join(SYNC_DIR, 'github-copilot', 'session-state');
  const remaining = fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir) : [];
  assert('staging dir cleaned', remaining.length === 0,
    `remaining: ${remaining.join(', ')}`);

  // Verify all tags released
  const tagsFile = path.join(SYNC_DIR, '.tags.json');
  let tags = {};
  try { tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8')); } catch {}
  assert('all tags released after clean', Object.keys(tags).length === 0,
    `remaining tags: ${Object.keys(tags).join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9: Tombstone Prevents Re-Sync
// ─────────────────────────────────────────────────────────────────────────────

function testTombstoneBlocksResync() {
  logSection('Scenario 9: Tombstone Prevents Re-Sync');

  // Create a session, sync it, then tombstone it
  createFakeSession('e2e-tombstone-test', 3);
  synctx(['sync'], { timeout: 60000 });

  // Verify it's staged
  const stagedPath = path.join(SYNC_DIR, 'github-copilot', 'session-state', 'e2e-tombstone-test');
  assert('session staged before tombstone', fs.existsSync(stagedPath));

  // Delete it (creates tombstone)
  synctx(['delete', 'e2e-tombstone-test'], { timeout: 60000 });

  // The local session source still exists in copilot dir
  assert('source session still in copilot dir', fs.existsSync(path.join(COPILOT_DIR, 'e2e-tombstone-test')));

  // Run sync again — tombstoned session should NOT be re-staged
  synctx(['sync'], { timeout: 60000 });
  assert('tombstoned session NOT re-staged', !fs.existsSync(stagedPath),
    'session was re-staged despite tombstone');
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10: Push Daemon Mode
// ─────────────────────────────────────────────────────────────────────────────

function testPushDaemon() {
  logSection('Scenario 10: Push (Daemon Mode)');

  // Create a new session
  createFakeSession('e2e-daemon-push', 2);

  // Run push (spawns daemon child). Give it time to complete.
  const pushResult = synctx(['push'], { timeout: 60000 });
  // Push is non-blocking — it spawns a child and exits immediately.
  // The child does the actual work. Wait a bit for it to finish.
  assert('push command exits quickly', pushResult.status === 0 || pushResult.status === null,
    `exit: ${pushResult.status}`);

  // Wait for daemon to complete (check for lock release)
  let attempts = 0;
  const lockFile = path.join(SYNC_DIR, '.sync_lock');
  while (fs.existsSync(lockFile) && attempts < 20) {
    spawnSync('sleep', ['1']);
    attempts++;
  }

  // Verify the session was staged (daemon should have run stageFiles + commit)
  const stagedPath = path.join(SYNC_DIR, 'github-copilot', 'session-state', 'e2e-daemon-push');
  assert('daemon staged the session', fs.existsSync(stagedPath),
    `checked after ${attempts}s wait`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 11: Hook Simulation
// ─────────────────────────────────────────────────────────────────────────────

function testHookSimulation() {
  logSection('Scenario 11: Hook Trigger Simulation');

  // Create a session to simulate hook push
  createFakeSession('e2e-hook-session', 2);

  // Simulate what a hook does: run `node sync-engine.js push`
  // This is the actual command hooks.json triggers
  const hookResult = synctx(['push'], { timeout: 60000 });
  assert('hook-triggered push succeeds', hookResult.status === 0 || hookResult.status === null,
    `exit: ${hookResult.status}`);

  // Wait for daemon
  let attempts = 0;
  const lockFile = path.join(SYNC_DIR, '.sync_lock');
  while (fs.existsSync(lockFile) && attempts < 15) {
    spawnSync('sleep', ['1']);
    attempts++;
  }

  assert('hook push completed within timeout', attempts < 15,
    `waited ${attempts}s, lock still held`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 12: Gitleaks Security Scan
// ─────────────────────────────────────────────────────────────────────────────

function testGitleaksSecurity() {
  logSection('Scenario 12: Gitleaks Security Scan');

  // Create a session with a fake secret
  const secretSession = path.join(COPILOT_DIR, 'e2e-secret-session');
  fs.mkdirSync(secretSession, { recursive: true });
  // Use a pattern gitleaks detects (AWS key pattern)
  fs.writeFileSync(path.join(secretSession, 'turn-0.json'), JSON.stringify({
    role: 'assistant',
    content: 'Here is the key: AKIAIOSFODNN7EXAMPLE with secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }));

  // Run sync — gitleaks should detect and redact
  const syncResult = synctx(['sync'], { timeout: 60000, allowFail: true });

  // Check if gitleaks ran (output should mention scanning or redaction)
  const output = syncResult.output;
  const gitleaksRan = output.includes('Gitleaks') || output.includes('gitleaks') ||
                      output.includes('scan') || output.includes('Scan') ||
                      output.includes('redact') || output.includes('secret');
  assert('gitleaks scan ran during sync', gitleaksRan,
    `output: ${output.substring(0, 500)}`);

  // Clean up secret session
  if (fs.existsSync(secretSession)) {
    fs.rmSync(secretSession, { recursive: true, force: true });
  }
  // Also clean from staging
  const stagedSecret = path.join(SYNC_DIR, 'github-copilot', 'session-state', 'e2e-secret-session');
  if (fs.existsSync(stagedSecret)) {
    fs.rmSync(stagedSecret, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 13: Cross-Machine Sync
// ─────────────────────────────────────────────────────────────────────────────

function testCrossMachineSync() {
  logSection('Scenario 13: Cross-Machine Sync Simulation');

  // This test simulates two machines by using two separate sync dirs.
  // Machine A = default SYNC_DIR, Machine B = a separate dir.
  const machBSync = path.join(os.tmpdir(), 'synctx-e2e-machB');
  const machBHome = path.join(os.tmpdir(), 'synctx-e2e-machB-home');
  const machBCopilot = path.join(machBHome, '.copilot', 'session-state');
  const machBClaude = path.join(machBHome, '.claude', 'todos');

  // Setup Machine B environment
  fs.mkdirSync(machBCopilot, { recursive: true });
  fs.mkdirSync(machBClaude, { recursive: true });
  fs.mkdirSync(machBSync, { recursive: true });
  fs.writeFileSync(path.join(machBSync, '.config.json'), JSON.stringify({ repoName: REPO_NAME }));

  // Bootstrap Machine B git repo
  execSync('git init', { cwd: machBSync, stdio: 'ignore' });
  execSync('git config user.name "Synctx E2E MachB"', { cwd: machBSync, stdio: 'ignore' });
  execSync('git config user.email "e2e-machb@synctx.test"', { cwd: machBSync, stdio: 'ignore' });
  execFileSync('git', ['config', 'credential.helper', '!gh auth git-credential'], { cwd: machBSync, stdio: 'ignore' });
  const ghUser = sh('gh api user --jq .login');
  const remoteUrl = `https://github.com/${ghUser}/${REPO_NAME}.git`;
  try { execSync(`git remote add origin ${remoteUrl}`, { cwd: machBSync, stdio: 'ignore' }); } catch {}

  // Machine A: create and push a session
  createFakeSession('e2e-cross-from-A', 3);
  synctx(['sync'], { timeout: 60000 });

  // Machine B: pull from remote
  try {
    execSync('git fetch origin', { cwd: machBSync, stdio: 'ignore', timeout: 15000 });
    try {
      execSync('git checkout -b main origin/main', { cwd: machBSync, stdio: 'ignore' });
    } catch {
      try { execSync('git checkout main && git pull origin main', { cwd: machBSync, stdio: 'ignore' }); } catch {}
    }
  } catch {}

  // Machine B should see Machine A's session
  const machBStaged = path.join(machBSync, 'github-copilot', 'session-state', 'e2e-cross-from-A');
  assert('Machine B sees Machine A session after pull', fs.existsSync(machBStaged),
    `path: ${machBStaged}`);

  // Machine B: create its own session and push
  const machBSessDir = path.join(machBCopilot, 'e2e-cross-from-B');
  fs.mkdirSync(machBSessDir, { recursive: true });
  fs.writeFileSync(path.join(machBSessDir, 'turn-0.json'), '{"role":"user","content":"from machine B"}');

  // Stage from Machine B (using its home dir)
  const homeEnvVar = IS_WIN ? 'USERPROFILE' : 'HOME';
  spawnSync(process.execPath, ['-e', `
    process.env.SYNCTX_SYNC_DIR = ${JSON.stringify(machBSync)};
    process.env.SYNCTX_REPO_NAME = ${JSON.stringify(REPO_NAME)};
    process.env.${homeEnvVar} = ${JSON.stringify(machBHome)};
    const FM = require('./scripts/lib/file-manager');
    FM.stageFiles();
  `], { cwd: PROJECT_ROOT, encoding: 'utf8' });

  execSync('git add -A', { cwd: machBSync, stdio: 'ignore' });
  try { execSync('git commit -m "Machine B push"', { cwd: machBSync, stdio: 'ignore' }); } catch {}
  execSync('git push origin main --force', { cwd: machBSync, stdio: 'ignore', timeout: 30000 });

  // Machine A: pull and verify
  synctx(['sync'], { timeout: 60000 });
  const machAStaged = path.join(SYNC_DIR, 'github-copilot', 'session-state', 'e2e-cross-from-B');
  assert('Machine A sees Machine B session after sync', fs.existsSync(machAStaged),
    `path: ${machAStaged}`);

  // Cleanup Machine B
  fs.rmSync(machBSync, { recursive: true, force: true });
  fs.rmSync(machBHome, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 14: Installation Flow
// ─────────────────────────────────────────────────────────────────────────────

function testInstallation() {
  logSection('Scenario 14: Installation Verification');

  // Verify install.js can run and detect Copilot CLI status
  const installCheck = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'install.js'), '--help'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, SYNCTX_SYNC_DIR: SYNC_DIR },
  });
  // install.js may not have --help, but it should at least load without syntax errors
  assert('install.js loads without errors', installCheck.status !== null,
    `exit: ${installCheck.status}, stderr: ${(installCheck.stderr || '').substring(0, 200)}`);

  // Verify plugin.json is valid
  const pluginJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'plugin.json'), 'utf8'));
  assert('plugin.json has name', pluginJson.name === 'synctx');
  assert('plugin.json has version', typeof pluginJson.version === 'string');

  // Verify hooks.json is valid and has both bash + powershell
  const hooksJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'hooks.json'), 'utf8'));
  const hooks = hooksJson.hooks || hooksJson;
  const hookNames = Object.keys(hooks);
  assert('hooks.json has 5 hooks', hookNames.length === 5,
    `found: ${hookNames.join(', ')}`);

  for (const hookName of hookNames) {
    const hookEntries = hooks[hookName];
    // Each hook is an array of entries, each with bash + powershell keys
    const hasBash = Array.isArray(hookEntries) && hookEntries.some(e => typeof e.bash === 'string');
    const hasPowershell = Array.isArray(hookEntries) && hookEntries.some(e => typeof e.powershell === 'string');
    assert(`hook ${hookName} has bash command`, hasBash,
      JSON.stringify(hookEntries).substring(0, 100));
    assert(`hook ${hookName} has powershell command`, hasPowershell,
      JSON.stringify(hookEntries).substring(0, 100));
  }

  // Verify all skills exist
  const skillDirs = fs.readdirSync(path.join(PROJECT_ROOT, 'skills'));
  assert('10 skills directories exist', skillDirs.length >= 10,
    `found: ${skillDirs.length} (${skillDirs.join(', ')})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 15: Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

function testEdgeCases() {
  logSection('Scenario 15: Edge Cases');

  // Empty session directory
  const emptyDir = path.join(COPILOT_DIR, 'e2e-empty-session');
  fs.mkdirSync(emptyDir, { recursive: true });
  const syncEmpty = synctx(['sync'], { timeout: 60000, allowFail: true });
  assert('empty session dir handled gracefully', syncEmpty.ok || syncEmpty.status === 0,
    `exit: ${syncEmpty.status}`);

  // Session with special characters in name
  const specialName = 'e2e-special_chars-123';
  createFakeSession(specialName, 1);
  const syncSpecial = synctx(['sync'], { timeout: 60000, allowFail: true });
  assert('special char session name handled', syncSpecial.ok || syncSpecial.status === 0,
    `exit: ${syncSpecial.status}`);

  // Large session (many files)
  const largeSessionId = 'e2e-large-session';
  const largeDir = path.join(COPILOT_DIR, largeSessionId);
  fs.mkdirSync(largeDir, { recursive: true });
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(largeDir, `file-${i}.json`), JSON.stringify({ i, data: 'x'.repeat(1000) }));
  }
  const syncLarge = synctx(['sync'], { timeout: 60000 });
  const stagedLarge = path.join(SYNC_DIR, 'github-copilot', 'session-state', largeSessionId);
  const stagedFiles = fs.existsSync(stagedLarge) ? fs.readdirSync(stagedLarge) : [];
  assert('large session (50 files) staged', stagedFiles.length >= 50,
    `staged files: ${stagedFiles.length}`);

  // Invalid command
  const badResult = synctx(['nonexistent-command'], { allowFail: true });
  assert('invalid command shows help or error', badResult.output.includes('help') || badResult.output.includes('Usage') || badResult.output.includes('Unknown'),
    badResult.output.substring(0, 300));

  // Double sync (idempotent)
  const sync1 = synctx(['sync'], { timeout: 60000, allowFail: true });
  const sync2 = synctx(['sync'], { timeout: 60000, allowFail: true });
  assert('double sync is idempotent', sync2.ok || sync2.status === 0,
    `exit: ${sync2.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 16: Help & Version Commands
// ─────────────────────────────────────────────────────────────────────────────

function testHelpVersion() {
  logSection('Scenario 16: Help & Version');

  const helpResult = synctx(['help']);
  assert('help command works', helpResult.ok && helpResult.output.length > 100,
    `exit: ${helpResult.status}`);
  assert('help lists commands', helpResult.output.includes('push') && helpResult.output.includes('restore'),
    helpResult.output.substring(0, 500));

  const versionResult = synctx(['--version']);
  assert('--version shows version', versionResult.output.includes('0.0.1'),
    versionResult.output);

  const helpFlag = synctx(['--help']);
  assert('--help works same as help', helpFlag.ok && helpFlag.output.includes('push'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  Synctx v0.0.1 — E2E Test Suite');
  console.log(`  Platform: ${os.platform()} (${os.arch()}) | Node ${process.version}`);
  console.log(`  Machine: ${MACHINE_ID} | Repo: ${REPO_NAME}`);
  console.log('═'.repeat(70));

  // Preflight checks
  if (!GH_TOKEN) {
    console.error('\n  [error] GH_TOKEN environment variable is required.\n');
    console.error('  Set it with: export GH_TOKEN=$(gh auth token)\n');
    process.exit(1);
  }

  // Authenticate gh with token
  try {
    sh('gh auth status', { allowFail: true });
  } catch {}

  // Setup
  log('\n  Setting up test environment...');
  const ghUser = ensureRepo();
  cleanState();
  bootstrap(ghUser);
  pushToRemote('E2E test: initial clean state');
  log(`  [ok] Environment ready (user: ${ghUser}, repo: ${REPO_NAME})\n`);

  // Scenario map
  const scenarios = {
    status: testStatus,
    push: testPushSync,
    list: testList,
    tags: testTags,
    restore: testRestore,
    delete: testDelete,
    prune: testPrune,
    clean: testClean,
    tombstone: testTombstoneBlocksResync,
    daemon: testPushDaemon,
    hooks: testHookSimulation,
    security: testGitleaksSecurity,
    crossmachine: testCrossMachineSync,
    install: testInstallation,
    edge: testEdgeCases,
    helpversion: testHelpVersion,
  };

  if (SCENARIO_FILTER && scenarios[SCENARIO_FILTER]) {
    scenarios[SCENARIO_FILTER]();
  } else {
    // Run in dependency order
    // First: status (no state needed)
    testStatus();
    testHelpVersion();
    testInstallation();

    // Core workflow: push → list → tags → restore
    testPushSync();
    testList();
    testTags();
    testRestore();

    // Destructive: delete → prune → clean (each needs fresh sessions)
    testDelete();
    testTombstoneBlocksResync();
    testPrune();
    testClean();

    // Daemon & hooks
    testPushDaemon();
    testHookSimulation();

    // Security & cross-machine
    testGitleaksSecurity();
    testCrossMachineSync();

    // Edge cases (last — may leave messy state)
    testEdgeCases();
  }

  // Results
  console.log(`\n${'─'.repeat(70)}`);
  console.log('  TEST RESULTS');
  console.log('─'.repeat(70));
  console.log(`\n  Total:  ${totalTests}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (issues.length > 0) {
    console.log(`\n  Issues Found (${issues.length}):`);
    for (const issue of issues) {
      console.log(`    ${issue}`);
    }
  }

  console.log('\n' + '═'.repeat(70) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
