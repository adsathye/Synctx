'use strict';

/**
 * @module commands/list
 * @description Lists all synced sessions from the sync repository.
 *
 * Usage:
 *   list              — List all sessions (auto-detect CLIs)
 *   list --cli copilot — List only Copilot sessions
 *   list --cli claude  — List only Claude sessions
 *   list --cli all     — List sessions from all CLIs
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');
const { CONFIG, getCLIMappings } = require('../config');
const { resolveCLIFilter, getLabel } = require('../cli-detect');
const { formatBytes } = require('../format');
const Tags = require('../tags');
const Tombstones = require('../tombstones');

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan a directory for sessions and return metadata.
 *
 * @param {string} dir — Directory to scan.
 * @returns {Array<{name: string, files: number, bytes: number, modified: Date}>}
 */
function scanSessions(dir) {
  if (!fs.existsSync(dir)) return [];

  const sessions = [];

  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Session directory (e.g., UUID folder)
      let files = 0;
      let bytes = 0;
      let latest = stat.mtime;

      try {
        const walk = (p) => {
          for (const child of fs.readdirSync(p)) {
            const childPath = path.join(p, child);
            const childStat = fs.statSync(childPath);
            if (childStat.isDirectory()) {
              walk(childPath);
            } else {
              files++;
              bytes += childStat.size;
              if (childStat.mtime > latest) latest = childStat.mtime;
            }
          }
        };
        walk(fullPath);
      } catch { /* skip unreadable */ }

      sessions.push({ name: entry, files, bytes, modified: latest, path: fullPath });
    } else {
      // Single file session (e.g., .jsonl)
      sessions.push({
        name: entry,
        files: 1,
        bytes: stat.size,
        modified: stat.mtime,
        path: fullPath,
      });
    }
  }

  // Sort by modified date, newest first
  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

/**
 * List all synced sessions, optionally filtered by CLI.
 *
 * @param {Object} options
 * @param {string} [options.cli] — 'copilot', 'claude', 'all', or undefined
 */
function execute(options = {}) {
  const { c } = require('../format');
  const cliNames = resolveCLIFilter(options.cli);
  const mappings = getCLIMappings().filter(m => cliNames.includes(m.name));

  let totalSessions = 0;

  for (const cli of mappings) {
    console.log(`\n${c.bold}${c.teal}  ${getLabel(cli.name)} Sessions${c.reset}`);
    console.log(`${c.dim}  ${'─'.repeat(65)}${c.reset}`);

    let cliHasSessions = false;

    for (const source of cli.sources) {
      const folderName = path.basename(source);
      const stagedDir = path.join(CONFIG.syncDir, cli.name, folderName);
      const sessions = scanSessions(stagedDir);

      if (sessions.length === 0) continue;
      cliHasSessions = true;

      const tombstoneData = Tombstones.readAll();

      for (const s of sessions) {
        // Skip empty or tombstoned sessions
        if (s.files === 0) continue;
        if (s.name in tombstoneData) continue;

        const date = s.modified.toISOString().replace(/T/, ' ').replace(/\..+/, '');
        const size = formatBytes(s.bytes);
        const sessionTags = Tags.getSessionTags(s.name);
        const tagStr = sessionTags.length > 0 ? `  ${c.orange}# ${sessionTags.join(', ')}${c.reset}` : '';

        console.log(`\n  ${c.blue}${s.name}${c.reset}${tagStr}`);
        console.log(`  ${c.dim}${s.files} file(s)  │  ${size}  │  ${date}${c.reset}`);
        totalSessions++;
      }
    }

    if (!cliHasSessions) {
      console.log(`  ${c.dim}(no synced sessions)${c.reset}`);
    }
  }

  console.log(`\n${c.dim}  ${'─'.repeat(65)}${c.reset}`);
  console.log(`  ${c.bold}${totalSessions}${c.reset} session(s)  ${c.dim}│${c.reset}  ${c.dim}${CONFIG.syncDir}${c.reset}\n`);
}

/**
 * Find a session by ID, partial ID, or the keyword "current".
 * "current" resolves to the most recently modified Copilot session.
 *
 * @param {string} id — Full or partial session ID, or "current".
 * @returns {{ id: string, cli: string, path: string } | null}
 */
function findSession(id) {
  if (!id) return null;

  // Resolve "current" to the most recently modified session
  if (id.toLowerCase() === 'current') {
    const os = require('os');
    const copilotDir = path.join(os.homedir(), '.copilot', 'session-state');
    try {
      const dirs = fs.readdirSync(copilotDir)
        .map(d => ({ name: d, mtime: fs.statSync(path.join(copilotDir, d)).mtimeMs }))
        .filter(d => fs.statSync(path.join(copilotDir, d.name)).isDirectory())
        .sort((a, b) => b.mtime - a.mtime);
      if (dirs.length > 0) {
        id = dirs[0].name;
      }
    } catch { /* fall through to normal search */ }
  }

  // Search staging directory first (synced from all machines)
  for (const cli of getCLIMappings()) {
    for (const source of cli.sources) {
      const folderName = path.basename(source);
      const stagedDir = path.join(CONFIG.syncDir, cli.name, folderName);
      const sessions = scanSessions(stagedDir);

      for (const s of sessions) {
        if (s.name === id || s.name.startsWith(id)) {
          if (Tombstones.isDeleted(s.name)) continue;
          return { id: s.name, cli: cli.name, path: s.path };
        }
      }
    }
  }

  // Fall back to local CLI directories (sessions not yet synced to staging)
  for (const cli of getCLIMappings()) {
    for (const source of cli.sources) {
      if (!fs.existsSync(source)) continue;
      const sessions = scanSessions(source);

      for (const s of sessions) {
        if (s.name === id || s.name.startsWith(id)) {
          if (Tombstones.isDeleted(s.name)) continue;
          return { id: s.name, cli: cli.name, path: s.path };
        }
      }
    }
  }

  return null;
}

module.exports = { execute, scanSessions, findSession };
