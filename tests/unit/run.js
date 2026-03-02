#!/usr/bin/env node
'use strict';

/**
 * Synctx — Unit Test Runner
 *
 * Lightweight test harness using only Node.js built-ins.
 * Discovers and runs all test files in tests/unit/.
 *
 * Usage:
 *   node tests/unit/run.js
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UNIT_DIR = __dirname;
const testFiles = fs.readdirSync(UNIT_DIR)
  .filter(f => f.endsWith('.test.js'))
  .sort();

if (testFiles.length === 0) {
  console.log('  No unit test files found.');
  process.exit(0);
}

let totalPassed = 0;
let totalFailed = 0;
let totalTests = 0;
const failures = [];

console.log(`\n  Synctx Unit Tests\n  ${'─'.repeat(50)}`);

for (const file of testFiles) {
  const filePath = path.join(UNIT_DIR, file);
  try {
    const result = execFileSync(process.execPath, [filePath], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, SYNCTX_UNIT_TEST: '1' },
    });
    // Parse summary line: "SUMMARY: X passed, Y failed, Z total"
    const match = result.match(/SUMMARY:\s*(\d+)\s*passed,\s*(\d+)\s*failed,\s*(\d+)\s*total/);
    if (match) {
      totalPassed += parseInt(match[1], 10);
      totalFailed += parseInt(match[2], 10);
      totalTests += parseInt(match[3], 10);
    }
    process.stdout.write(result);
    if (parseInt(match?.[2] || '0', 10) > 0) {
      failures.push(file);
    }
  } catch (err) {
    totalFailed++;
    totalTests++;
    failures.push(file);
    console.log(`\n  ✗ ${file} — CRASHED`);
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
  }
}

console.log(`\n  ${'─'.repeat(50)}`);
console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalTests} total`);

if (failures.length > 0) {
  console.log(`\n  Failed files: ${failures.join(', ')}`);
  process.exit(1);
}

console.log('');
process.exit(0);
