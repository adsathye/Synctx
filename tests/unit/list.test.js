#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/lib/commands/list.js
 *
 * Tests findSession() behavior with tombstoned sessions.
 * Uses a temp directory to isolate filesystem operations.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Set up isolated temp dir before requiring modules
const tmpDir = path.join(os.tmpdir(), 'synctx-unit-test-list-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.SYNCTX_SYNC_DIR = tmpDir;

// Clear config cache so it picks up new SYNCTX_SYNC_DIR
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'))];

const { findSession } = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'commands', 'list'));
const Tombstones = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'tombstones'));
const { CONFIG } = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'));

let passed = 0;
let failed = 0;
let total = 0;

function assert(name, actual, expected) {
  total++;
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name} \u2014 expected ${expectedStr}, got ${actualStr}`);
  }
}

/**
 * Create a fake session directory in the staging area.
 * @param {string} cliName - e.g., 'github-copilot'
 * @param {string} folderName - e.g., 'session-state'
 * @param {string} sessionId - e.g., 'abc-123-def'
 */
function createStagedSession(cliName, folderName, sessionId) {
  const dir = path.join(CONFIG.syncDir, cliName, folderName, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test.txt'), 'test content');
}

console.log('\n  list.js \u2014 findSession()');

// ── Normal session lookup ───────────────────────────────────────────────────
const sid1 = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
createStagedSession('github-copilot', 'session-state', sid1);
const found1 = findSession(sid1);
assert('finds live session by exact id', found1 !== null && found1.id === sid1, true);

// ── Tombstoned session is skipped ───────────────────────────────────────────
const sid2 = 'cccccccc-4444-5555-6666-dddddddddddd';
createStagedSession('github-copilot', 'session-state', sid2);
Tombstones.record(sid2, 'github-copilot', 'delete');
const found2 = findSession(sid2);
assert('skips tombstoned session (exact)', found2, null);

// ── Partial ID match works ──────────────────────────────────────────────────
const sid3 = 'eeeeeeee-7777-8888-9999-ffffffffffff';
createStagedSession('claude', 'projects', sid3);
const found3 = findSession('eeeeeeee-7777');
assert('partial match finds live session', found3 !== null && found3.id === sid3, true);

// ── Partial ID match skips tombstoned ───────────────────────────────────────
const sid4 = 'deadbeef-aaaa-bbbb-cccc-111111111111';
createStagedSession('claude', 'projects', sid4);
Tombstones.record(sid4, 'claude', 'prune');
const found4 = findSession('deadbeef');
assert('partial match skips tombstoned', found4, null);

// ── Non-existent session returns null ───────────────────────────────────────
const found5 = findSession('nonexistent-session-id');
assert('returns null for non-existent', found5, null);

// ── Null/empty input returns null ───────────────────────────────────────────
assert('returns null for null input', findSession(null), null);
assert('returns null for empty string', findSession(''), null);

// ── Live session next to tombstoned one is still found ──────────────────────
const sid5 = 'live-session-beside-dead';
const sid6 = 'live-session-beside-alive';
createStagedSession('github-copilot', 'session-state', sid5);
createStagedSession('github-copilot', 'session-state', sid6);
Tombstones.record(sid5, 'github-copilot', 'delete');
const found6 = findSession(sid6);
assert('live session beside tombstoned is found', found6 !== null && found6.id === sid6, true);
const found7 = findSession(sid5);
assert('tombstoned session beside live is skipped', found7, null);

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }

console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${total} total`);
if (failed > 0) process.exit(1);
