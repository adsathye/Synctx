'use strict';

/**
 * @module file-manager
 * @description Handles recursive file operations between source CLI
 * directories and the staging area.
 *
 * Key operations:
 *   stageFiles()          — Copy CLI state → staging (for push)
 *   cleanStaging()        — Wipe staged data only
 *
 * SAFETY: This module ONLY READS from user's CLI directories
 * (~/.copilot/, ~/.claude/). It NEVER writes to, deletes from,
 * or modifies the original session files.
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');
const { CONFIG, getCLIMappings } = require('./config');
const Logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// Recursive Copy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively copy a file or directory tree with per-file error recovery.
 *
 * If an individual file copy fails, the error is logged to the provided
 * `errors` array and the operation continues. This prevents a single bad
 * file from aborting the entire sync.
 *
 * @param {string}   src    — source path
 * @param {string}   dest   — destination path
 * @param {Object}   [stats] — running stats counter
 * @param {number}   stats.files  — files copied so far
 * @param {number}   stats.bytes  — bytes copied so far
 * @param {string[]} stats.errors — error messages for failed copies
 */
function copyRecursiveSync(src, dest, stats = { files: 0, bytes: 0, errors: [] }) {
  if (!fs.existsSync(src)) return stats;

  let srcStat;
  try {
    if (fs.lstatSync(src).isSymbolicLink()) {
      stats.errors.push(`symlink skipped: ${src} — refusing to follow symlinks`);
      return stats;
    }
  } catch (err) {
    stats.errors.push(`lstat failed: ${src} — ${err.message}`);
    return stats;
  }
  try {
    srcStat = fs.statSync(src);
  } catch (err) {
    stats.errors.push(`stat failed: ${src} — ${err.message}`);
    return stats;
  }

  if (srcStat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    let children;
    try {
      children = fs.readdirSync(src);
    } catch (err) {
      stats.errors.push(`readdir failed: ${src} — ${err.message}`);
      return stats;
    }

    for (const child of children) {
      copyRecursiveSync(path.join(src, child), path.join(dest, child), stats);
    }
  } else {
    try {
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      // Delta check: skip copy if dest is identical (same size and mtime)
      if (fs.existsSync(dest)) {
        try {
          const destStat = fs.statSync(dest);
          if (destStat.size === srcStat.size && Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < 1000) {
            stats.files++;
            stats.bytes += srcStat.size;
            return stats;
          }
        } catch { /* dest unreadable, proceed with copy */ }
      }

      // Atomic copy: write to temp then rename to avoid partial files on crash
      const tmpDest = dest + '.tmp';
      fs.copyFileSync(src, tmpDest);
      fs.renameSync(tmpDest, dest);
      stats.files++;
      stats.bytes += srcStat.size;
    } catch (err) {
      stats.errors.push(`copy failed: ${src} → ${dest} — ${err.message}`);
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mirror Deletions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove files/directories in `dest` that no longer exist in `source`.
 * Walks dest recursively and deletes anything not present in the source tree.
 *
 * @param {string} source — the authoritative source directory
 * @param {string} dest   — the mirror directory to clean
 */
function mirrorDeletions(source, dest) {
  if (!fs.existsSync(dest)) return;

  let children;
  try {
    children = fs.readdirSync(dest);
  } catch { return; }

  for (const child of children) {
    const srcChild = path.join(source, child);
    const destChild = path.join(dest, child);

    if (!fs.existsSync(srcChild)) {
      // Source no longer has this entry — remove from dest
      try {
        fs.rmSync(destChild, { recursive: true, force: true });
      } catch { /* best-effort removal */ }
    } else {
      // If both are directories, recurse
      try {
        if (fs.statSync(destChild).isDirectory() && fs.statSync(srcChild).isDirectory()) {
          mirrorDeletions(srcChild, destChild);
        }
      } catch { /* stat failure, skip */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage (Source → Staging)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage all CLI session files into the local staging directory.
 *
 * Uses delta sync: copies only changed files (by size/mtime), then
 * mirrors deletions so removed sessions are also removed from remote.
 *
 * @returns {{ sources: number, files: number, bytes: number, errors: string[] }}
 */
function stageFiles() {
  const totals = { sources: 0, files: 0, bytes: 0, errors: [] };
  const Tombstones = require('./tombstones');
  const tombstoneData = Tombstones.readAll();

  // Proactive cleanup: remove tombstoned sessions that linger in staging
  for (const cli of getCLIMappings()) {
    for (const source of cli.sources) {
      const folderName = path.basename(source);
      const stagedDir = path.join(CONFIG.syncDir, cli.name, folderName);
      if (!fs.existsSync(stagedDir)) continue;
      try {
        for (const entry of fs.readdirSync(stagedDir)) {
          if (entry in tombstoneData) {
            fs.rmSync(path.join(stagedDir, entry), { recursive: true, force: true });
          }
        }
      } catch { /* best effort */ }
    }
  }

  for (const cli of getCLIMappings()) {
    let cliHasSources = false;
    
    for (const source of cli.sources) {
      if (!fs.existsSync(source)) continue;
      
      cliHasSources = true;

      const folderName = path.basename(source);
      const destDir = path.join(CONFIG.syncDir, cli.name, folderName);

      // Walk top-level entries and skip tombstoned sessions
      let children;
      try {
        children = fs.readdirSync(source);
      } catch (err) {
        totals.errors.push(`readdir failed: ${source} — ${err.message}`);
        continue;
      }

      for (const child of children) {
        if (child in tombstoneData) continue;
        const srcPath = path.join(source, child);
        const dstPath = path.join(destDir, child);
        const result = copyRecursiveSync(srcPath, dstPath);
        totals.files += result.files;
        totals.bytes += result.bytes;
        totals.errors.push(...result.errors);
      }

      // SAFETY: mirrorDeletions() is intentionally NOT called here.
      // In a multi-machine setup, the staging directory contains sessions
      // from ALL machines (pulled from remote). Deleting entries absent from
      // THIS machine's local source would destroy other machines' sessions
      // on the next push. Session cleanup is handled explicitly via the
      // delete, prune, and clean commands, which record tombstones.

      totals.sources++;
    }
    
    // Log if no sources were found for this CLI
    if (!cliHasSources) {
      Logger.log('INFO', `No session data found for ${cli.name}`);
    }
  }

  return totals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clean
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove staged CLI data from the staging directory.
 * Does NOT touch the .git directory, audit log, or user's original CLI dirs.
 */
function cleanStaging() {
  for (const cli of getCLIMappings()) {
    const destDir = path.join(CONFIG.syncDir, cli.name);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  stageFiles,
  cleanStaging,
};
