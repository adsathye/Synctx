'use strict';

/**
 * @module tags
 * @description Manages friendly session tags stored in .tags.json.
 *
 * Tags are unique, human-friendly aliases for session IDs.
 * The manifest syncs across machines via the git-backed staging directory.
 *
 * @license MIT
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG } = require('./config');

const TAGS_FILE = path.join(CONFIG.syncDir, '.tags.json');

/** Tag name validation: 2-50 chars, lowercase alphanumeric + hyphens + underscores. */
const TAG_REGEX = /^[a-z0-9][a-z0-9_-]{1,49}$/;

/** UUID-like pattern to distinguish tags from session IDs. */
const UUID_REGEX = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,3}/i;

// ─────────────────────────────────────────────────────────────────────────────

/** Read the tags manifest. Handles git merge conflicts gracefully. */
function readTags() {
  try {
    if (fs.existsSync(TAGS_FILE)) {
      let content = fs.readFileSync(TAGS_FILE, 'utf8');

      // Handle git merge conflict markers in .tags.json
      if (content.includes('<<<<<<<') && content.includes('>>>>>>>')) {
        const merged = resolveTagConflict(content);
        writeTags(merged);
        return merged;
      }

      return JSON.parse(content);
    }
  } catch { /* corrupt file — start fresh */ }
  return {};
}

/**
 * Resolve git merge conflicts in .tags.json by keeping both sides.
 * If the same tag points to different sessions, the newer entry wins
 * and the older one gets suffixed with the machine hostname.
 *
 * @param {string} content — Raw file content with conflict markers.
 * @returns {Object} Merged tags object.
 */
function resolveTagConflict(content) {
  const merged = {};

  // Extract JSON blocks between conflict markers
  const blocks = content.split(/^[<>=]{7}.*$/m).filter(b => b.trim());
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block.trim());
      for (const [tag, entry] of Object.entries(parsed)) {
        if (!merged[tag]) {
          merged[tag] = entry;
        } else if (merged[tag].sessionId !== entry.sessionId) {
          // Conflict: same tag, different sessions — keep newer, suffix older
          const existing = new Date(merged[tag].createdAt || 0).getTime();
          const incoming = new Date(entry.createdAt || 0).getTime();
          if (incoming > existing) {
            // Move old entry to suffixed tag
            const suffix = `-${os.hostname().toLowerCase().slice(0, 8)}`;
            merged[tag + suffix] = merged[tag];
            merged[tag] = entry;
          } else {
            const suffix = `-${os.hostname().toLowerCase().slice(0, 8)}`;
            merged[tag + suffix] = entry;
          }
        }
        // Same tag, same session — no conflict, keep either
      }
    } catch {
      // Block isn't valid JSON — skip
    }
  }

  return merged;
}

/** Write the tags manifest atomically. */
function writeTags(tags) {
  const dir = path.dirname(TAGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = TAGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tags, null, 2) + '\n');
  fs.renameSync(tmp, TAGS_FILE);
}

/**
 * Validate a tag name.
 *
 * @param {string} tag — The tag to validate.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateTag(tag) {
  if (!tag || typeof tag !== 'string') {
    return { valid: false, error: 'Tag name is required.' };
  }
  const normalized = tag.toLowerCase().trim();
  if (normalized.length < 2) {
    return { valid: false, error: 'Tag must be at least 2 characters.' };
  }
  if (normalized.length > 50) {
    return { valid: false, error: 'Tag must be 50 characters or fewer.' };
  }
  if (!TAG_REGEX.test(normalized)) {
    return { valid: false, error: 'Tag must be lowercase alphanumeric with hyphens/underscores (e.g., "auth-refactor").' };
  }
  if (UUID_REGEX.test(normalized)) {
    return { valid: false, error: 'Tag must not look like a UUID (to avoid ambiguity with session IDs).' };
  }
  return { valid: true };
}

/**
 * Assign a tag to a session.
 *
 * @param {string} tag — Friendly tag name.
 * @param {string} sessionId — Session ID or directory name.
 * @param {string} cli — CLI namespace ('github-copilot' or 'claude').
 * @returns {{ success: boolean, error?: string }}
 */
function assign(tag, sessionId, cli) {
  const validation = validateTag(tag);
  if (!validation.valid) return { success: false, error: validation.error };

  // Pull latest tags from remote to detect conflicts early
  try {
    const { execFileSync } = require('child_process');
    execFileSync('git', ['pull', 'origin', 'main', '--no-edit'], {
      cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true,
    });
  } catch { /* offline or empty repo — continue with local */ }

  const normalized = tag.toLowerCase().trim();
  const tags = readTags();

  if (tags[normalized] && tags[normalized].sessionId !== sessionId) {
    return {
      success: false,
      error: `Tag "${normalized}" is already assigned to session ${tags[normalized].sessionId.slice(0, 8)}. Use 'synctx untag ${normalized}' first, or choose a different name.`,
    };
  }

  // One tag per session — remove any existing tag for this session
  let replacedTag = null;
  for (const [existingTag, entry] of Object.entries(tags)) {
    if (entry.sessionId === sessionId && existingTag !== normalized) {
      replacedTag = existingTag;
      delete tags[existingTag];
    }
  }

  tags[normalized] = {
    cli,
    sessionId,
    createdAt: new Date().toISOString(),
  };

  writeTags(tags);

  if (replacedTag) {
    return {
      success: true,
      assignedTag: normalized,
      warning: `Replaced tag "${replacedTag}" with "${normalized}"`,
    };
  }
  return { success: true, assignedTag: normalized };
}

/**
 * Remove a tag.
 *
 * @param {string} tag — Tag name to remove.
 * @returns {{ success: boolean, error?: string }}
 */
function remove(tag) {
  if (!tag) return { success: false, error: 'Tag name is required.' };

  const normalized = tag.toLowerCase().trim();
  const tags = readTags();

  if (!tags[normalized]) {
    return { success: false, error: `Tag "${normalized}" not found.` };
  }

  delete tags[normalized];
  writeTags(tags);
  return { success: true };
}

/**
 * Resolve a tag or session ID to { cli, sessionId }.
 * Checks tags first, then treats as session ID.
 *
 * @param {string} input — Tag name or session ID.
 * @returns {{ cli?: string, sessionId?: string, isTag: boolean } | null}
 */
function resolve(input) {
  if (!input) return null;

  const normalized = input.toLowerCase().trim();
  const tags = readTags();

  if (tags[normalized]) {
    return {
      cli: tags[normalized].cli,
      sessionId: tags[normalized].sessionId,
      isTag: true,
      tag: normalized,
    };
  }

  return null; // Not a tag — caller should try session ID matching
}

/**
 * Get all tags, optionally filtered by CLI.
 *
 * @param {string} [cli] — Optional CLI filter ('github-copilot' or 'claude').
 * @returns {Object} Tags manifest (filtered).
 */
function list(cli) {
  const tags = readTags();
  if (!cli) return tags;

  const filtered = {};
  for (const [tag, entry] of Object.entries(tags)) {
    if (entry.cli === cli) filtered[tag] = entry;
  }
  return filtered;
}

/**
 * Get tags for a specific session.
 *
 * @param {string} sessionId — Session ID.
 * @returns {string[]} Array of tag names.
 */
function getSessionTags(sessionId) {
  const tags = readTags();
  const result = [];
  for (const [tag, entry] of Object.entries(tags)) {
    if (entry.sessionId === sessionId) result.push(tag);
  }
  return result;
}

/**
 * Remove all tags pointing to a specific session.
 * Called when a session is deleted or pruned to free tag names for reuse.
 *
 * @param {string} sessionId — Session ID.
 * @returns {string[]} Tag names that were removed.
 */
function removeBySession(sessionId) {
  const tags = readTags();
  const removed = [];
  for (const [tag, entry] of Object.entries(tags)) {
    if (entry.sessionId === sessionId) {
      delete tags[tag];
      removed.push(tag);
    }
  }
  if (removed.length > 0) writeTags(tags);
  return removed;
}

module.exports = {
  assign,
  remove,
  removeBySession,
  resolve,
  list,
  getSessionTags,
  validateTag,
  readTags,
  TAGS_FILE,
};
