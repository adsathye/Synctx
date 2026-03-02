'use strict';

/**
 * @module lock
 * @description PID-aware concurrency lock with automatic stale-lock recovery.
 *
 * Prevents multiple sync processes from running simultaneously across
 * terminals. The lock file stores the owning process PID so that stale
 * locks from crashed daemons can be detected and recovered without
 * waiting for a timeout.
 *
 * Lock file format (JSON):
 *   { "pid": <number>, "timestamp": "<ISO string>" }
 *
 * @license MIT
 */

const fs = require('fs');
const { CONFIG } = require('./config');

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a process with the given PID is still running.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    // signal 0 = existence check only, no signal sent
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse the lock file contents.
 *
 * @returns {{ pid: number, timestamp: string } | null}
 */
function readLock() {
  try {
    const raw = fs.readFileSync(CONFIG.lockFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Acquire the concurrency lock.
 *
 * Strategy:
 *   1. If no lock exists → create atomically (O_CREAT|O_EXCL).
 *   2. If lock exists and owning PID is still alive AND lock is younger
 *      than lockTTL → refuse (another sync is running).
 *   3. If lock exists but owning PID is dead → stale lock from crash,
 *      remove and re-acquire immediately.
 *   4. If lock exists and older than lockTTL → stale lock from hang,
 *      remove and re-acquire.
 *
 * @returns {boolean} `true` if the lock was acquired.
 */
function acquire() {
  try {
    if (!fs.existsSync(CONFIG.syncDir)) {
      fs.mkdirSync(CONFIG.syncDir, { recursive: true });
    }

    // Fast path — try atomic creation first
    const payload = JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() });
    try {
      fs.writeFileSync(CONFIG.lockFile, payload, { flag: 'wx' });
      return true;
    } catch {
      // File already exists — inspect it
    }

    // Lock exists — read it and decide
    const lock = readLock();

    if (lock) {
      const age = Date.now() - new Date(lock.timestamp).getTime();
      const ownerAlive = isProcessAlive(lock.pid);

      if (ownerAlive && age < CONFIG.lockTTL) {
        // Legitimate active lock — back off
        return false;
      }

      // Stale: owner dead OR TTL exceeded → reclaim.
      // Note on PID reuse safety: even if the OS reassigned this PID to an
      // unrelated process, the TTL check above ensures we only hold off for
      // a bounded window. Once age >= lockTTL the lock is reclaimed regardless
      // of PID liveness — a reused PID for a lock older than the TTL is
      // almost certainly not our sync daemon.
      if (!ownerAlive) {
        // Owner crashed — safe to reclaim immediately
      }
      // else: TTL exceeded — owner may be hung or PID was reused, reclaim
    }

    // Remove stale lock and re-acquire atomically.
    // Note: there is a brief race window between unlink and writeFile where
    // another process could also unlink+write. The 'wx' flag (O_CREAT|O_EXCL)
    // on writeFileSync ensures only one process ultimately wins the lock.
    try { fs.unlinkSync(CONFIG.lockFile); } catch { /* race-safe */ }

    try {
      fs.writeFileSync(CONFIG.lockFile, payload, { flag: 'wx' });
      return true;
    } catch {
      // Another process beat us — that's fine
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Refresh the lock timestamp to prevent TTL expiry during long operations.
 * Call this periodically during multi-step pipelines.
 */
function refresh() {
  try {
    const payload = JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() });
    fs.writeFileSync(CONFIG.lockFile, payload);
  } catch {
    // Best-effort
  }
}

/**
 * Release the lock (best-effort). Only releases if we are the owner.
 */
function release() {
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) {
      fs.unlinkSync(CONFIG.lockFile);
    } else if (!lock) {
      // Lock file gone or unreadable — nothing to do
    }
    // If PID doesn't match, don't release someone else's lock
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Clean up stale locks from crashed processes.
 * Call at the start of any interactive command to prevent
 * stale lock warnings. Safe to call from any process.
 */
function cleanStale() {
  const lock = readLock();
  if (!lock) return;

  const ownerAlive = isProcessAlive(lock.pid);
  if (!ownerAlive) {
    try { fs.unlinkSync(CONFIG.lockFile); } catch { /* race-safe */ }
  }
}

module.exports = { acquire, refresh, release, cleanStale };
