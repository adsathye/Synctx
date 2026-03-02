'use strict';

/**
 * @module commands/delete
 * @description Delete a session from the sync repository with double confirmation.
 *
 * Usage:
 *   delete <session-id>                — Delete from auto-detected CLI
 *   delete <session-id> --cli copilot  — Delete from Copilot sessions
 *   delete <session-id> --cli claude   — Delete from Claude sessions
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
 * Find a session by name/id across the specified CLIs.
 *
 * @param {string} sessionId — Session name or UUID to find.
 * @param {string[]} cliNames — CLI names to search in.
 * @returns {Array<{cli: string, folder: string, session: Object}>}
 */
function findSession(sessionId, cliNames) {
  const matches = [];
  const mappings = getCLIMappings().filter(m => cliNames.includes(m.name));

  for (const cli of mappings) {
    for (const source of cli.sources) {
      const folderName = path.basename(source);
      const stagedDir = path.join(CONFIG.syncDir, cli.name, folderName);
      const sessions = scanSessions(stagedDir);

      for (const s of sessions) {
        // Match by exact name or partial UUID match
        if (s.name === sessionId || s.name.startsWith(sessionId)) {
          matches.push({ cli: cli.name, folder: folderName, session: s });
        }
      }
    }
  }

  return matches;
}

/**
 * Delete a session from the sync repo with double confirmation.
 *
 * @param {Object} options
 * @param {string} options.sessionId — Session name or partial UUID.
 * @param {string} [options.cli] — 'copilot', 'claude', 'all', or undefined.
 */
async function execute(options = {}) {
  let { sessionId } = options;

  if (!sessionId) {
    console.error('[error] Please specify a session ID or tag to delete.');
    console.error('   Usage: delete <session-id|tag> [--cli copilot|claude]');
    console.error('   Use "list" to see available sessions, "tags" to see tags.');
    return;
  }

  // Resolve tag to session ID if applicable
  const Tags = require('../tags');
  const resolved = Tags.resolve(sessionId);
  let resolvedTag = null;
  if (resolved) {
    resolvedTag = resolved.tag;
    sessionId = resolved.sessionId;
    if (resolved.cli) options.cli = options.cli || resolved.cli.replace('github-copilot', 'copilot');
  }

  const cliNames = resolveCLIFilter(options.cli);
  const matches = findSession(sessionId, cliNames);

  if (matches.length === 0) {
    console.error(`[error] No session found matching "${sessionId}".`);
    console.error('   Use "list" to see available sessions.');
    return;
  }

  if (matches.length > 1) {
    console.log(`Found ${matches.length} sessions matching "${sessionId}":\n`);
    for (const m of matches) {
      const size = formatBytes(m.session.bytes);
      console.log(`  [${getLabel(m.cli)}] ${m.folder}/${m.session.name} (${size})`);
    }
    console.error('\n[error] Ambiguous match. Please provide a more specific session ID.');
    return;
  }

  const match = matches[0];
  const size = formatBytes(match.session.bytes);

  const description = [
    `This will permanently delete the following session:`,
    ``,
    `  CLI:      ${getLabel(match.cli)}`,
    `  Session:  ${match.session.name}`,
    `  Location: ${match.folder}/`,
    `  Size:     ${size} (${match.session.files} file(s))`,
    `  Modified: ${match.session.modified.toISOString().replace(/T/, ' ').replace(/\..+/, '')}`,
    ``,
    `The session will be removed from the local sync directory and the`,
    `remote repository. It will be tombstoned — it will NOT be re-synced`,
    `from any other machine. Any tags pointing to this session will be released.`,
  ].join('\n');

  const confirmed = await doubleConfirm(description);
  if (!confirmed) return;

  // Delete from staging
  try {
    fs.rmSync(match.session.path, { recursive: true, force: true });
    console.log(`\n[remove] Deleted: ${match.session.name}`);
  } catch (err) {
    Logger.log('ERROR', `Failed to delete staged session: ${err.message}`);
    console.error(`[warn] Failed to delete: ${err.message}`);
    return;
  }

  // Record tombstone to prevent re-sync from other machines
  const Tombstones = require('../tombstones');
  Tombstones.record(match.session.name, match.cli, 'delete');

  // Remove any tags pointing to this session (frees tag names for reuse)
  const removedTags = Tags.removeBySession(match.session.name);
  if (removedTags.length > 0) {
    console.log(`[info] Released tag(s): ${removedTags.join(', ')}`);
  }

  // Commit and push the deletion
  const pSync = progress('Sync');
  pSync.update('Syncing deletion to remote...');
  try {
    GitManager.commitAndPush(`Delete session: ${getLabel(match.cli)}/${match.session.name}`);
    pSync.done('Deletion synced to remote');
  } catch (err) {
    Logger.log('ERROR', `Failed to sync deletion: ${err.message}`);
    pSync.skip('Deleted locally (remote sync failed)');
  }

  Logger.log('USER_ACTION', `Deleted session: ${getLabel(match.cli)}/${match.folder}/${match.session.name}`);
  console.log('[ok] Session deleted successfully.');
}

module.exports = { execute };
