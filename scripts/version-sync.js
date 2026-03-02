#!/usr/bin/env node
'use strict';

/**
 * Synctx — Version Sync
 *
 * Reads the version from package.json (single source of truth) and
 * updates all other files that contain a version field.
 *
 * Usage:
 *   node scripts/version-sync.js           — Sync current version
 *   node scripts/version-sync.js 0.1.0     — Set version and sync
 *   npm version patch && node scripts/version-sync.js  — Bump and sync
 *
 * Files updated:
 *   - plugin.json
 *   - .claude-plugin/plugin.json
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');

// Read package.json
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

// If a version argument is provided, update package.json first
const newVersion = process.argv[2];
if (newVersion) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
    console.error(`[error] Invalid version format: "${newVersion}". Use semver (e.g., 0.1.0)`);
    process.exit(1);
  }
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  [info] package.json → ${newVersion}`);
}

const version = pkg.version;

// Files to sync version into
const TARGETS = [
  path.join(ROOT, 'plugin.json'),
  path.join(ROOT, '.claude-plugin', 'plugin.json'),
];

let updated = 0;
for (const target of TARGETS) {
  if (!fs.existsSync(target)) continue;

  const content = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (content.version !== version) {
    content.version = version;
    fs.writeFileSync(target, JSON.stringify(content, null, 2) + '\n');
    const rel = path.relative(ROOT, target);
    console.log(`  [ok] ${rel} → ${version}`);
    updated++;
  }
}

console.log(`\n>> Version: ${version} (${updated} file(s) updated)`);
