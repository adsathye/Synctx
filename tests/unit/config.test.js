#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/lib/config.js
 */

const path = require('path');
const os = require('os');

// Set up isolated env
const tmpDir = path.join(os.tmpdir(), 'synctx-unit-test-config-' + process.pid);
process.env.SYNCTX_SYNC_DIR = tmpDir;

// Clear config cache
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'))];

const { VERSION, CONFIG, getCLIMappings, reloadConfig } = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'));

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

console.log('\n  config.js');

// VERSION
assertTruthy('VERSION is a semver string', /^\d+\.\d+\.\d+/.test(VERSION));

// CONFIG basic properties
assertTruthy('CONFIG.gitHost is a string', typeof CONFIG.gitHost === 'string');
assert('CONFIG.syncDir from env', CONFIG.syncDir, tmpDir);
assertTruthy('CONFIG.lockTTL is a number', typeof CONFIG.lockTTL === 'number');
assertTruthy('CONFIG.lockTTL > 0', CONFIG.lockTTL > 0);
assertTruthy('CONFIG.commitWindow is a number', typeof CONFIG.commitWindow === 'number');
assertTruthy('CONFIG.branch is a string', typeof CONFIG.branch === 'string');
assertTruthy('CONFIG.gcInterval > 0', CONFIG.gcInterval > 0);

// Derived paths
assertTruthy('CONFIG.auditDir contains syncDir', CONFIG.auditDir.startsWith(tmpDir));
assertTruthy('CONFIG.auditLog contains auditDir', CONFIG.auditLog.startsWith(CONFIG.auditDir));
assertTruthy('CONFIG.lockFile contains syncDir', CONFIG.lockFile.startsWith(tmpDir));
assertTruthy('CONFIG.lastSyncFile contains syncDir', CONFIG.lastSyncFile.startsWith(tmpDir));
assertTruthy('CONFIG.lastGcFile contains syncDir', CONFIG.lastGcFile.startsWith(tmpDir));

// getCLIMappings
const mappings = getCLIMappings();
assertTruthy('getCLIMappings returns array', Array.isArray(mappings));
assertTruthy('getCLIMappings has entries', mappings.length >= 2);

const names = mappings.map(m => m.name);
assertTruthy('has github-copilot mapping', names.includes('github-copilot'));
assertTruthy('has claude mapping', names.includes('claude'));

// Each mapping has name and sources
for (const mapping of mappings) {
  assertTruthy(`${mapping.name}: has name`, typeof mapping.name === 'string');
  assertTruthy(`${mapping.name}: has sources array`, Array.isArray(mapping.sources));
  assertTruthy(`${mapping.name}: sources not empty`, mapping.sources.length > 0);
  for (const src of mapping.sources) {
    assertTruthy(`${mapping.name}: source is absolute path`, path.isAbsolute(src));
  }
}

// Frozen (immutable)
assertTruthy('getCLIMappings is frozen', Object.isFrozen(mappings));

// reloadConfig is a function
assertTruthy('reloadConfig is a function', typeof reloadConfig === 'function');

// Env var override
process.env.SYNCTX_REPO_NAME = 'test-repo-override';
reloadConfig();
assert('reloadConfig picks up env var', CONFIG.repoName, 'test-repo-override');
delete process.env.SYNCTX_REPO_NAME;

console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${total} total`);
if (failed > 0) process.exit(1);
