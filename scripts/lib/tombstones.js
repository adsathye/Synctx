'use strict';

/**
 * @module tombstones
 * @description Manages a deletion manifest (.deletions.json) that prevents
 * deleted/pruned/cleaned sessions from being re-synced by other machines.
 *
 * When a session is deleted, its ID is recorded as a tombstone. During
 * stageFiles(), tombstoned sessions are skipped — even if they still exist
 * in the local CLI directory. The manifest syncs across machines via git.
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

const TOMBSTONE_FILE = path.join(CONFIG.syncDir, '.deletions.json');

/**
 * Read the tombstone manifest.
 * @returns {Object} Map of sessionId → { cli, reason, deletedAt }
 */
function readAll() {
  try {
    if (fs.existsSync(TOMBSTONE_FILE)) {
      return JSON.parse(fs.readFileSync(TOMBSTONE_FILE, 'utf8'));
    }
  } catch { /* corrupt — start fresh */ }
  return {};
}

/**
 * Write the tombstone manifest atomically.
 * @param {Object} data — Full manifest to write.
 */
function writeAll(data) {
  const dir = path.dirname(TOMBSTONE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = TOMBSTONE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, TOMBSTONE_FILE);
}

/**
 * Record a single session as deleted.
 * @param {string} sessionId — Session directory name or UUID.
 * @param {string} cli — CLI namespace ('github-copilot' or 'claude').
 * @param {string} reason — 'delete', 'prune', or 'clean'.
 */
function record(sessionId, cli, reason) {
  const data = readAll();
  data[sessionId] = {
    cli,
    reason,
    deletedAt: new Date().toISOString(),
  };
  writeAll(data);
}

/**
 * Record multiple sessions as deleted.
 * @param {Array<{sessionId: string, cli: string}>} sessions
 * @param {string} reason — 'delete', 'prune', or 'clean'.
 */
function recordMany(sessions, reason) {
  const data = readAll();
  const now = new Date().toISOString();
  for (const { sessionId, cli } of sessions) {
    data[sessionId] = { cli, reason, deletedAt: now };
  }
  writeAll(data);
}

/**
 * Check if a session has been tombstoned.
 * @param {string} sessionId — Session directory name.
 * @returns {boolean}
 */
function isDeleted(sessionId) {
  const data = readAll();
  return sessionId in data;
}

module.exports = { readAll, record, recordMany, isDeleted, TOMBSTONE_FILE };
