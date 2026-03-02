'use strict';

/**
 * @module cli-detect
 * @description Detects which AI CLI the user is running inside.
 *
 * Detection strategy (in order):
 *   1. Explicit --cli flag from the user
 *   2. COPILOT_SESSION / CLAUDE_SESSION env vars (set by some CI setups)
 *   3. Check which CLI state directories contain data on this machine
 *
 * @license MIT
 */

const fs = require('fs');
const { getCLIMappings } = require('./config');

// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, string>} Map of CLI names to display labels. */
const CLI_LABELS = Object.freeze({
  'github-copilot': 'Copilot',
  'claude': 'Claude',
});

/**
 * Detect which CLI(s) have session data on this machine.
 *
 * @returns {string[]} Array of CLI names that have at least one source dir.
 */
function detectAvailableCLIs() {
  const available = [];

  for (const cli of getCLIMappings()) {
    const hasData = cli.sources.some(src => {
      if (!fs.existsSync(src)) return false;
      try {
        return fs.readdirSync(src).length > 0;
      } catch {
        return false;
      }
    });

    if (hasData) available.push(cli.name);
  }

  return available;
}

/**
 * Resolve a CLI filter argument to the internal name(s).
 *
 * @param {string|undefined} filter — 'copilot', 'claude', 'all', or undefined
 * @returns {string[]} Array of CLI names to operate on.
 */
function resolveCLIFilter(filter) {
  if (!filter || filter === 'all') {
    return getCLIMappings().map(m => m.name);
  }

  const normalized = filter.toLowerCase().trim();

  if (normalized === 'copilot' || normalized === 'github-copilot') {
    return ['github-copilot'];
  }
  if (normalized === 'claude') {
    return ['claude'];
  }

  // Auto-detect
  if (normalized === 'auto') {
    return detectAvailableCLIs();
  }

  // Unknown — return all
  return getCLIMappings().map(m => m.name);
}

/**
 * Get the display label for a CLI name.
 *
 * @param {string} cliName
 * @returns {string}
 */
function getLabel(cliName) {
  return CLI_LABELS[cliName] || cliName;
}

module.exports = { resolveCLIFilter, getLabel };
