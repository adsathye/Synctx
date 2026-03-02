#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/lib/tombstones.js
 *
 * Uses a temp directory to isolate filesystem operations.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Set up isolated temp dir before requiring modules
const tmpDir = path.join(os.tmpdir(), 'synctx-unit-test-tombs-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.SYNCTX_SYNC_DIR = tmpDir;

// Clear config cache
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'))];

const tombstones = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'tombstones'));

let passed = 0;
let failed = 0;
let total = 0;

function assert(name, actual, expected) {
  total++;
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${expectedStr}, got ${actualStr}`);
  }
}

console.log('\n  tombstones.js');

// readAll: empty when no file exists
assert('readAll: empty initially', typeof tombstones.readAll(), 'object');
assert('readAll: no entries', Object.keys(tombstones.readAll()).length, 0);

// record: single session
tombstones.record('session-abc', 'github-copilot', 'delete');
const afterRecord = tombstones.readAll();
assert('record: session exists', 'session-abc' in afterRecord, true);
assert('record: cli stored', afterRecord['session-abc'].cli, 'github-copilot');
assert('record: reason stored', afterRecord['session-abc'].reason, 'delete');
assert('record: has deletedAt', typeof afterRecord['session-abc'].deletedAt, 'string');

// isDeleted
assert('isDeleted: recorded session', tombstones.isDeleted('session-abc'), true);
assert('isDeleted: unknown session', tombstones.isDeleted('session-xyz'), false);

// record: another session
tombstones.record('session-def', 'claude', 'prune');
assert('record: second session', tombstones.isDeleted('session-def'), true);
assert('record: first still exists', tombstones.isDeleted('session-abc'), true);

// recordMany: batch
tombstones.recordMany([
  { sessionId: 'batch-1', cli: 'github-copilot' },
  { sessionId: 'batch-2', cli: 'claude' },
  { sessionId: 'batch-3', cli: 'github-copilot' },
], 'clean');
assert('recordMany: batch-1', tombstones.isDeleted('batch-1'), true);
assert('recordMany: batch-2', tombstones.isDeleted('batch-2'), true);
assert('recordMany: batch-3', tombstones.isDeleted('batch-3'), true);
const afterBatch = tombstones.readAll();
assert('recordMany: reason', afterBatch['batch-1'].reason, 'clean');
assert('recordMany: cli', afterBatch['batch-2'].cli, 'claude');

// Previous records survive batch
assert('recordMany: previous records survive', tombstones.isDeleted('session-abc'), true);

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }

console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${total} total`);
if (failed > 0) process.exit(1);
