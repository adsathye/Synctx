#!/usr/bin/env node
'use strict';

/**
 * Unit tests for scripts/lib/format.js
 */

const path = require('path');
const { formatBytes } = require(path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'format'));

let passed = 0;
let failed = 0;
let total = 0;

function assert(name, actual, expected) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected "${expected}", got "${actual}"`);
  }
}

console.log('\n  format.js');

// formatBytes
assert('formatBytes(0)', formatBytes(0), '0B');
assert('formatBytes(1)', formatBytes(1), '1B');
assert('formatBytes(512)', formatBytes(512), '512B');
assert('formatBytes(1023)', formatBytes(1023), '1023B');
assert('formatBytes(1024)', formatBytes(1024), '1.0KB');
assert('formatBytes(1536)', formatBytes(1536), '1.5KB');
assert('formatBytes(10240)', formatBytes(10240), '10.0KB');
assert('formatBytes(1048576)', formatBytes(1048576), '1.0MB');
assert('formatBytes(1572864)', formatBytes(1572864), '1.5MB');
assert('formatBytes(10485760)', formatBytes(10485760), '10.0MB');

console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${total} total`);
if (failed > 0) process.exit(1);
