'use strict';

/**
 * @module commands/prune
 * @description Retention pruning — delete sessions older than N days from staging.
 *
 * Usage:
 *   prune                         — Prune sessions older than 90 days (default)
 *   prune --days 30               — Prune sessions older than 30 days
 *   prune --cli copilot           — Prune only Copilot sessions
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');
const { CONFIG, getCLIMappings } = require('../config');
const { resolveCLIFilter, getLabel } = require('../cli-detect');
const { doubleConfirm } = require('../confirm');
const Logger = require('../logger');
const GitManager = require('../git-manager');
const { scanSessions } = require('./list');
const { formatBytes, progress } = require('../format');

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all sessions older than the given cutoff date.
 *
 * @param {string[]} cliNames — CLI names to scan.
 * @param {Date} cutoff — Sessions older than this are candidates.
 * @returns {Array<{cli: string, folder: string, session: Object}>}
 */
function findOldSessions(cliNames, cutoff) {
  const results = [];
  const mappings = getCLIMappings().filter(m => cliNames.includes(m.name));

  for (const cli of mappings) {
    for (const source of cli.sources) {
      const folderName = path.basename(source);
      const stagedDir = path.join(CONFIG.syncDir, cli.name, folderName);
      const sessions = scanSessions(stagedDir);

      for (const s of sessions) {
        if (s.modified < cutoff) {
          results.push({ cli: cli.name, folder: folderName, session: s });
        }
      }
    }
  }

  return results;
}

/**
 * Prune sessions older than N days from the staging directory.
 *
 * @param {Object} options
 * @param {number} [options.days=90] — Age threshold in days.
 * @param {string} [options.cli] — 'copilot', 'claude', 'all', or undefined.
 */
async function execute(options = {}) {
  const days = options.days != null ? options.days : 90;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cliNames = resolveCLIFilter(options.cli);

  const candidates = findOldSessions(cliNames, cutoff);

  if (candidates.length === 0) {
    console.log(`[ok] No sessions older than ${days} days found. Nothing to prune.`);
    return;
  }

  // List what would be pruned
  let totalBytes = 0;
  let totalFiles = 0;
  console.log(`\n[list] Sessions older than ${days} days (before ${cutoff.toISOString().split('T')[0]}):\n`);

  for (const c of candidates) {
    const date = c.session.modified.toISOString().replace(/T/, ' ').replace(/\..+/, '');
    const size = formatBytes(c.session.bytes);
    console.log(`  [${getLabel(c.cli)}] ${c.folder}/${c.session.name}`);
    console.log(`    ${c.session.files} file(s), ${size}, last modified: ${date}`);
    totalBytes += c.session.bytes;
    totalFiles += c.session.files;
  }

  console.log(`\n  Total: ${candidates.length} session(s), ${totalFiles} file(s), ${formatBytes(totalBytes)}`);

  // Double confirmation
  const description = [
    `This will permanently delete ${candidates.length} session(s) older than ${days} days.`,
    ``,
    `  Total size: ${formatBytes(totalBytes)} (${totalFiles} file(s))`,
    ``,
    `The sessions will be removed from the local sync directory and the`,
    `remote repository. They will be tombstoned — they will NOT be re-synced`,
    `from any other machine. Any tags pointing to these sessions will be released.`,
  ].join('\n');

  const confirmed = await doubleConfirm(description);
  if (!confirmed) return;

  // Delete the sessions
  let deleted = 0;
  const deletedSessions = [];
  for (const c of candidates) {
    try {
      fs.rmSync(c.session.path, { recursive: true, force: true });
      deleted++;
      deletedSessions.push({ sessionId: c.session.name, cli: c.cli });
    } catch (err) {
      Logger.log('ERROR', `Failed to prune session: ${c.session.name} — ${err.message}`);
      console.error(`[warn] Failed to delete ${c.session.name}: ${err.message}`);
    }
  }

  console.log(`\n[remove] Pruned ${deleted} of ${candidates.length} session(s).`);

  // Record tombstones to prevent re-sync from other machines
  if (deletedSessions.length > 0) {
    const Tombstones = require('../tombstones');
    Tombstones.recordMany(deletedSessions, 'prune');

    // Remove tags pointing to pruned sessions
    const Tags = require('../tags');
    let releasedTags = 0;
    for (const { sessionId } of deletedSessions) {
      releasedTags += Tags.removeBySession(sessionId).length;
    }
    if (releasedTags > 0) {
      console.log(`[info] Released ${releasedTags} tag(s).`);
    }
  }

  // Commit and push
  const pSync = progress('Sync');
  pSync.update('Syncing pruning to remote...');
  try {
    GitManager.commitAndPush(`Prune: removed ${deleted} session(s) older than ${days} days`);
    pSync.done('Pruning synced to remote');
  } catch (err) {
    Logger.log('ERROR', `Failed to sync pruning: ${err.message}`);
    pSync.skip('Pruned locally (remote sync failed)');
  }

  Logger.log('USER_ACTION', `Pruned ${deleted} session(s) older than ${days} days.`);
  console.log('[ok] Retention pruning complete.');
}

module.exports = { execute };
