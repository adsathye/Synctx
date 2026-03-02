#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/lib/file-manager.js
 *
 * Tests module exports and stageFiles/cleanStaging with temp directory isolation.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Set up isolated temp dir
const tmpDir = path.join(os.tmpdir(), 'synctx-unit-test-fm-' + process.pid);
const syncDir = path.join(tmpDir, 'sync');
fs.mkdirSync(syncDir, { recursive: true });
process.env.SYNCTX_SYNC_DIR = syncDir;

// Clear config cache
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'))];
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'file-manager'))];

const fm = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'file-manager'));

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

function assertTruthy(name, value) {
  total++;
  if (value) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected truthy, got ${JSON.stringify(value)}`);
  }
}

console.log('\n  file-manager.js');

// Module exports
assertTruthy('exports stageFiles', typeof fm.stageFiles === 'function');
assertTruthy('exports cleanStaging', typeof fm.cleanStaging === 'function');

// stageFiles: returns stats object (may copy 0 files if no CLI dirs exist)
const stats = fm.stageFiles();
assertTruthy('stageFiles returns object', stats && typeof stats === 'object');
assertTruthy('stageFiles has sources', typeof stats.sources === 'number');
assertTruthy('stageFiles has files', typeof stats.files === 'number');
assertTruthy('stageFiles has bytes', typeof stats.bytes === 'number');
assertTruthy('stageFiles has errors array', Array.isArray(stats.errors));

// cleanStaging: should not throw even on empty sync dir
let cleanThrew = false;
try {
  fm.cleanStaging();
} catch {
  cleanThrew = true;
}
assert('cleanStaging: no throw on empty', cleanThrew, false);

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }

console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${total} total`);
if (failed > 0) process.exit(1);
