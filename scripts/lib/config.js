'use strict';

/**
 * @module config
 * @description Central configuration and strict CLI-to-path schema mapping.
 *
 * To add a new CLI tool, append an entry to the array returned by
 * {@link getCLIMappings}. Each entry needs:
 *   - `name`    — namespace used inside the staging directory
 *   - `sources` — ordered list of real OS paths to sync
 *
 * Environment variable overrides:
 *   SYNCTX_GIT_HOST  — Git host (default: github.com)
 *   SYNCTX_SYNC_DIR  — Staging directory override
 *   SYNCTX_REPO_NAME — sync repository name override
 *   SYNCTX_LOCK_TTL  — Lock debounce window in ms (default: 300000)
 *
 * @license MIT
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// Version (single source of truth: package.json)
// ─────────────────────────────────────────────────────────────────────────────

const PKG = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
);

/** Plugin version from package.json. */
const VERSION = PKG.version;

// ─────────────────────────────────────────────────────────────────────────────
// User Config (persisted by postinstall.js)
// ─────────────────────────────────────────────────────────────────────────────

const USER_CONFIG_FILE = path.join(os.homedir(), '.synctx', '.config.json');

/** Read user config (repo name, etc.) saved during setup. */
function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const userConfig = readUserConfig();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const _config = {
  /** Remote Git host for the sync repository. */
  gitHost: process.env.SYNCTX_GIT_HOST || 'github.com',

  /** Local staging directory that mirrors CLI state 1:1. */
  syncDir:
    process.env.SYNCTX_SYNC_DIR ||
    path.join(os.homedir(), '.synctx'),

  /** Lock debounce window in milliseconds (5 minutes). */
  lockTTL: Number(process.env.SYNCTX_LOCK_TTL) || 300_000,

  /** Commit amend window in milliseconds (4 hours).
   *  Pushes within this window amend the same commit instead of creating new ones. */
  commitWindow: Number(process.env.SYNCTX_COMMIT_WINDOW) || 4 * 60 * 60 * 1000,

  /** Name of the private sync repository on GitHub.
   *  Priority: env var > user config (.config.json) > default */
  repoName:
    process.env.SYNCTX_REPO_NAME ||
    userConfig.repoName ||
    '.synctx',

  /** Git branch name for the sync repository. */
  branch: process.env.SYNCTX_BRANCH || 'main',

  /** Derived: path to the audit log directory. */
  get auditDir() {
    return path.join(this.syncDir, 'security-audit');
  },

  /** Derived: path to the general audit log. */
  get auditLog() {
    return path.join(this.auditDir, 'general.log');
  },

  /** Derived: path to the concurrency lock file. */
  get lockFile() {
    return path.join(this.syncDir, '.sync_lock');
  },

  /** Derived: path to the last-sync timestamp file. */
  get lastSyncFile() {
    return path.join(this.syncDir, '.last_sync');
  },

  /** Derived: path to the last gc timestamp file. */
  get lastGcFile() {
    return path.join(this.syncDir, '.last_gc');
  },

  /** Interval between aggressive gc runs in milliseconds (24 hours). */
  gcInterval: 24 * 60 * 60 * 1000,
};

const CONFIG = _config;

/**
 * Reload CONFIG.repoName from env var or user config file.
 * Called after first-run setup writes .config.json.
 */
function reloadConfig() {
  const fresh = readUserConfig();
  _config.repoName =
    process.env.SYNCTX_REPO_NAME ||
    fresh.repoName ||
    '.synctx';
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Schema Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the strict CLI-to-path mapping for this OS.
 *
 * Each entry defines:
 *   name    — the namespace used inside the staging directory
 *   sources — ordered list of real OS paths to sync
 *
 * To support a new CLI:
 *   1. Add a new object with `name` and `sources`.
 *   2. Ensure the `name` is unique and kebab-case.
 *   3. List source directories in priority order.
 *
 * @returns {ReadonlyArray<{name: string, sources: string[]}>}
 */
function getCLIMappings() {
  const home = os.homedir();

  return Object.freeze([
    {
      name: 'github-copilot',
      sources: [
        // Primary: session-state (Copilot CLI v0.0.342+)
        path.join(home, '.copilot', 'session-state'),
        // Legacy: history-session-state
        path.join(home, '.copilot', 'history-session-state'),
      ],
    },
    {
      name: 'claude',
      sources: [
        // Claude Code project sessions (primary session data)
        path.join(home, '.claude', 'projects'),
        // Claude Code todos
        path.join(home, '.claude', 'todos'),
      ],
    },
  ]);
}

module.exports = { VERSION, CONFIG, getCLIMappings, reloadConfig };
