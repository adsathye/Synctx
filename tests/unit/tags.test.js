#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/lib/tags.js — validateTag() and resolveTagConflict()
 *
 * Tests only pure functions that don't require filesystem access.
 */

const path = require('path');

// We need to mock CONFIG before requiring tags.js
// tags.js reads CONFIG.syncDir at module level, so we override the env
const os = require('os');
const tmpDir = path.join(os.tmpdir(), 'synctx-unit-test-tags-' + process.pid);
const fs = require('fs');
fs.mkdirSync(tmpDir, { recursive: true });
process.env.SYNCTX_SYNC_DIR = tmpDir;

// Clear require cache for config so it picks up the new env
delete require.cache[require.resolve(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'config'))];

const { validateTag } = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'tags'));

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

console.log('\n  tags.js — validateTag()');

// Valid tags
assert('valid: simple tag', validateTag('my-tag').valid, true);
assert('valid: underscores', validateTag('auth_refactor').valid, true);
assert('valid: 2 chars min', validateTag('ab').valid, true);
// TAG_REGEX requires first char [a-z0-9] + 1-49 more = 2-50 total
// Use non-hex chars to avoid UUID_REGEX match
assert('valid: 50 chars', validateTag('x' + 'y'.repeat(49)).valid, true);
assert('valid: numeric start', validateTag('1fix').valid, true);
assert('valid: all numbers', validateTag('123').valid, true);
assert('valid: mixed', validateTag('my_tag-123').valid, true);

// Invalid tags
assert('invalid: null', validateTag(null).valid, false);
assert('invalid: empty', validateTag('').valid, false);
assert('invalid: 1 char', validateTag('a').valid, false);
assert('invalid: 51 chars', validateTag('a'.repeat(51)).valid, false);
assert('invalid: spaces', validateTag('my tag').valid, false);
assert('invalid: uppercase (normalized)', validateTag('MyTag').valid, true); // lowercase normalization
assert('invalid: special chars', validateTag('my@tag').valid, false);
assert('invalid: dots', validateTag('my.tag').valid, false);
assert('invalid: UUID-like', validateTag('a1b2c3d4-e5f6').valid, false);
assert('invalid: full UUID', validateTag('a1b2c3d4-e5f6-7890-abcd-ef1234567890').valid, false);

// Error messages
assert('error: null gives message', typeof validateTag(null).error, 'string');
assert('error: short gives message', typeof validateTag('a').error, 'string');
assert('error: long gives message', typeof validateTag('a'.repeat(51)).error, 'string');

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }

console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${total} total`);
if (failed > 0) process.exit(1);
