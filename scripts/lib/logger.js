'use strict';

/**
 * @module logger
 * @description Structured audit logger with per-CLI and per-session files.
 *
 * Log structure:
 *   ~/.synctx/security-audit/
 *     ├── general.log                         — All events
 *     ├── copilot/
 *     │   ├── copilot.log                     — Copilot sync events
 *     │   └── {session-id}.json               — Per-session redaction report
 *     ├── claude/
 *     │   ├── claude.log                      — Claude sync events
 *     │   └── {session-id}.json               — Per-session redaction report
 *     └── redactions.log                      — All redactions (quick overview)
 *
 * @license MIT
 */

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

// ─────────────────────────────────────────────────────────────────────────────

/** @type {ReadonlyArray<string>} Log levels echoed to the console. */
const LOUD_LEVELS = Object.freeze([
  'ERROR', 'SECURITY_SCAN', 'SECURITY_REDACT', 'USER_ACTION',
]);

/**
 * Ensure a directory exists.
 *
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append a log entry to a specific file.
 *
 * @param {string} filePath — Full path to the log file.
 * @param {string} entry    — Formatted log line.
 */
function appendTo(filePath, entry) {
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, entry);
  } catch {
    process.stderr.write(`[LOG-WRITE-FAIL] ${entry}`);
  }
}

/**
 * Write a timestamped log entry.
 *
 * Always writes to general.log. Additionally routes to:
 *   - copilot/copilot.log or claude/claude.log if `cli` is provided
 *   - redactions.log if level is SECURITY_REDACT
 *
 * @param {'INFO'|'ERROR'|'SECURITY_SCAN'|'SECURITY_REDACT'|'USER_ACTION'} level
 * @param {string} message
 * @param {Object}  [options]
 * @param {string}  [options.cli]     — 'github-copilot' or 'claude' for per-CLI routing.
 * @param {string}  [options.session] — Session ID for per-session routing.
 */
function log(level, message, options = {}) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}\n`;

  // Always write to general log
  appendTo(CONFIG.auditLog, entry);

  // Route to per-CLI log
  const cliName = options.cli === 'github-copilot' ? 'copilot'
    : options.cli === 'claude' ? 'claude'
    : null;

  if (cliName) {
    const cliLog = path.join(CONFIG.auditDir, cliName, `${cliName}.log`);
    appendTo(cliLog, entry);
  }

  // Route redactions to dedicated log
  if (level === 'SECURITY_REDACT') {
    const redactLog = path.join(CONFIG.auditDir, 'redactions.log');
    appendTo(redactLog, entry);
  }

  if (LOUD_LEVELS.includes(level)) {
    console.log(entry.trim());
  }
}

/**
 * Write a per-session redaction report as a JSON file.
 *
 * Creates or appends to:
 *   security-audit/{cli}/{session-id}.json
 *
 * @param {string} cli       — 'github-copilot' or 'claude'
 * @param {string} sessionId — Session UUID or project name
 * @param {Object} finding   — Gitleaks finding object
 */
function logSessionRedaction(cli, sessionId, finding) {
  const cliName = cli === 'github-copilot' ? 'copilot' : cli;
  const reportDir = path.join(CONFIG.auditDir, cliName);
  const reportFile = path.join(reportDir, `${sessionId}.json`);

  ensureDir(reportDir);

  // Read existing report or create new
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    report = {
      sessionId,
      cli: cliName,
      createdAt: new Date().toISOString(),
      redactions: [],
    };
  }

  report.updatedAt = new Date().toISOString();
  report.redactions.push({
    timestamp: new Date().toISOString(),
    ruleId: finding.RuleID || 'unknown',
    file: finding.File || '',
    line: finding.StartLine || null,
    description: finding.Description || '',
    fingerprint: finding.Fingerprint || '',
  });

  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  } catch {
    // best-effort
  }
}

module.exports = { log, logSessionRedaction };
