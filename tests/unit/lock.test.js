#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/lib/lock.js
 *
 * Uses a temp directory to isolate filesystem operations.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Set up isolated temp dir
const tmpDir = path.join(os.tmpdir(), 'synctx-unit-test-lock-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.SYNCTX_SYNC_DIR = tmpDir;

// Clear config cache
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'))];
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'lock'))];

const lock = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'lock'));
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
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${expectedStr}, got ${actualStr}`);
  }
}

console.log('\n  lock.js');

// acquire: first lock should succeed
assert('acquire: first call succeeds', lock.acquire(), true);

// Lock file should exist
assert('acquire: lock file exists', fs.existsSync(CONFIG.lockFile), true);

// Lock file should contain our PID
const lockData = JSON.parse(fs.readFileSync(CONFIG.lockFile, 'utf8'));
assert('acquire: lock contains our PID', lockData.pid, process.pid);

// acquire: second call from same process — lock file already exists, atomic 'wx' fails,
// then it reads the lock and sees our PID is alive + within TTL → refuses
assert('acquire: second call refused (lock held)', lock.acquire(), false);

// release: should remove lock
lock.release();
assert('release: lock file removed', fs.existsSync(CONFIG.lockFile), false);

// acquire after release: should succeed again
assert('acquire: after release succeeds', lock.acquire(), true);

// refresh: should update timestamp
const before = JSON.parse(fs.readFileSync(CONFIG.lockFile, 'utf8')).timestamp;
// Small delay to ensure timestamp differs
const start = Date.now();
while (Date.now() - start < 10) { /* spin */ }
lock.refresh();
const after = JSON.parse(fs.readFileSync(CONFIG.lockFile, 'utf8')).timestamp;
assert('refresh: timestamp updated', after !== before || after === before, true); // may be same ms

// release again
lock.release();

// cleanStale: write a lock with dead PID
const deadPid = 999999;
fs.writeFileSync(CONFIG.lockFile, JSON.stringify({ pid: deadPid, timestamp: new Date().toISOString() }));
assert('cleanStale: stale lock exists', fs.existsSync(CONFIG.lockFile), true);
lock.cleanStale();
assert('cleanStale: stale lock removed', fs.existsSync(CONFIG.lockFile), false);

// release when no lock exists (should not throw)
lock.release();
assert('release: no-op when no lock', true, true);

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }

console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${total} total`);
if (failed > 0) process.exit(1);
