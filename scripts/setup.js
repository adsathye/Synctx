#!/usr/bin/env node
'use strict';

/**
 * Synctx — Setup Script
 *
 * Registers session sync hooks into Claude Code's settings.json.
 * Copilot CLI hooks are handled via hooks.json in the plugin directory.
 *
 * Usage:
 *   node scripts/setup.js           — Install Claude hooks
 *   node scripts/setup.js uninstall — Remove Claude hooks
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Resolve the sync-engine path relative to this script
const SYNC_ENGINE = path.resolve(__dirname, 'sync-engine.js');

const HOOK_ENTRY = {
  matcher: '*',
  hooks: [
    {
      type: 'command',
      command: `node "${SYNC_ENGINE}" push`,
      timeout: 120,
    },
  ],
};

// Marker to identify our hooks
const MARKER = 'synctx';

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  const dir = path.dirname(CLAUDE_SETTINGS);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

function isOurHook(entry) {
  return entry?.hooks?.some(h =>
    typeof h.command === 'string' && h.command.includes('sync-engine.js'),
  );
}

function install() {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  let added = 0;

  for (const event of ['PostToolUse', 'SessionEnd']) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Skip if already installed
    if (settings.hooks[event].some(isOurHook)) {
      console.log(`  [ok] ${event} hook already registered`);
      continue;
    }

    settings.hooks[event].push(HOOK_ENTRY);
    added++;
    console.log(`  [+] ${event} hook added`);
  }

  writeSettings(settings);

  if (added > 0) {
    console.log(`\n[ok] Claude Code hooks installed (${CLAUDE_SETTINGS})`);
  } else {
    console.log('\n[ok] Claude Code hooks already up to date.');
  }
}

function uninstall() {
  const settings = readSettings();
  if (!settings.hooks) {
    console.log('No hooks to remove.');
    return;
  }

  let removed = 0;

  for (const event of ['PostToolUse', 'SessionEnd']) {
    if (!settings.hooks[event]) continue;

    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(e => !isOurHook(e));
    removed += before - settings.hooks[event].length;

    // Clean up empty arrays
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settings);
  console.log(`[ok] Removed ${removed} Claude Code hook(s).`);
}

// --- CLI ---
const action = process.argv[2] || 'install';

console.log('>> Synctx — Claude Code Hook Setup\n');

if (action === 'install') {
  install();
} else if (action === 'uninstall') {
  uninstall();
} else {
  console.error(`Unknown action: "${action}". Use: install | uninstall`);
  process.exit(1);
}
