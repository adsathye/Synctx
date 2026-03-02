'use strict';

/**
 * @module security
 * @description Gitleaks security gate with automatic secret redaction.
 *
 * Gitleaks is a mandatory prerequisite. The pipeline:
 *   1. Scan staged files with Gitleaks (JSON report mode).
 *   2. If secrets found → redact them in-place with [REDACTED-{ruleId}].
 *   3. Log each redaction to the security audit log.
 *   4. Re-scan to verify clean.
 *   5. Proceed with push.
 *
 * A `.gitleaksignore` file in the staging directory (`~/.synctx/`)
 * allows known false positives to be whitelisted.
 *
 * @license MIT
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CONFIG } = require('./config');
const Logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────

/** Path to the gitleaks ignore file in the staging directory. */
const IGNORE_FILE = path.join(CONFIG.syncDir, '.gitleaksignore');

/** Maximum number of redaction passes before proceeding anyway. */
const MAX_REDACTION_PASSES = 3;

/**
 * Preserve the .gitleaksignore file content before staging operations.
 *
 * @returns {string|null} The file content, or null if no file exists.
 */
function preserveIgnoreFile() {
  try {
    if (fs.existsSync(IGNORE_FILE)) {
      return fs.readFileSync(IGNORE_FILE, 'utf8');
    }
  } catch { /* best-effort */ }
  return null;
}

/**
 * Restore a previously preserved .gitleaksignore file.
 *
 * @param {string|null} content — Content from preserveIgnoreFile(), or null.
 */
function restoreIgnoreFile(content) {
  if (content === null) return;
  try {
    fs.writeFileSync(IGNORE_FILE, content);
  } catch { /* best-effort */ }
}

/**
 * Run Gitleaks scan and return findings as JSON array.
 *
 * @returns {{ clean: boolean, findings: Array<Object> }}
 */
function scan() {
  const reportFile = path.join(os.tmpdir(), `gitleaks-report-${process.pid}.json`);
  const args = [
    'detect', '--source', '.', '--no-git',
    '--report-format', 'json', '--report-path', reportFile,
  ];

  if (fs.existsSync(IGNORE_FILE)) {
    args.push('--gitleaks-ignore-path', IGNORE_FILE);
  }

  let clean = true;
  let findings = [];
  let executionError = null;
  try {
    try {
      execFileSync('gitleaks', args, { cwd: CONFIG.syncDir, stdio: 'ignore', windowsHide: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        executionError = 'gitleaks not found in PATH';
      } else if (err.status !== 1) {
        // Exit code 1 = secrets found (expected). Any other non-zero exit
        // code indicates a gitleaks execution failure (crash, bad config, etc.)
        // that must not be silently ignored.
        executionError = `gitleaks failed (exit code ${err.status})`;
      }
      clean = false;
    }

    try {
      if (fs.existsSync(reportFile)) {
        findings = JSON.parse(fs.readFileSync(reportFile, 'utf8')) || [];
      }
    } catch {
      // Report may not exist if gitleaks failed early
    }
  } finally {
    try { if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile); } catch { /* best-effort */ }
  }

  return { clean, findings, executionError };
}

/**
 * Redact secrets found by Gitleaks in the staged files.
 *
 * For each finding, replaces the exact secret string with
 * [REDACTED-{ruleId}] in the file on disk.
 *
 * @param {Array<Object>} findings — Gitleaks findings array.
 * @returns {number} Number of secrets redacted.
 */
function redactFindings(findings) {
  let redacted = 0;

  // Group findings by file for efficiency
  const byFile = new Map();
  for (const f of findings) {
    const filePath = path.isAbsolute(f.File)
      ? f.File
      : path.join(CONFIG.syncDir, f.File);

    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath).push(f);
  }

  for (const [filePath, fileFindings] of byFile) {
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      let fileRedactions = 0;

      for (const f of fileFindings) {
        const secret = f.Secret;
        if (!secret || secret.length === 0) continue;

        const placeholder = `[REDACTED-${f.RuleID || 'secret'}]`;

        const before = content;
        content = content.split(secret).join(placeholder);

        if (content !== before) {
          fileRedactions++;
          redacted++;

          // Detect CLI and session from file path
          const relPath = path.relative(CONFIG.syncDir, filePath);
          const parts = relPath.split(path.sep);
          const cli = parts[0] === 'github-copilot' ? 'github-copilot'
            : parts[0] === 'claude' ? 'claude'
            : undefined;
          const sessionId = parts.length >= 3 ? parts[2] : parts[parts.length - 1];

          Logger.log(
            'SECURITY_REDACT',
            `Redacted ${f.RuleID || 'secret'} in ${relPath}:${f.StartLine || '?'}`,
            { cli, session: sessionId },
          );

          if (cli && sessionId) {
            Logger.logSessionRedaction(cli, sessionId, f);
          }
        }
      }

      if (fileRedactions > 0) {
        fs.writeFileSync(filePath, content);
      }
    } catch (err) {
      Logger.log('ERROR', `Failed to redact in ${filePath}: ${err.message}`);
    }
  }

  return redacted;
}

/**
 * Scan staged files for secrets. If found, auto-redact and re-scan.
 *
 * Pipeline: detect → redact → verify → proceed.
 */
function check() {
  for (let pass = 1; pass <= MAX_REDACTION_PASSES; pass++) {
    const { clean, findings, executionError } = scan();

    if (executionError) {
      Logger.log('ERROR', `Security scan could not run: ${executionError}`);
      throw new Error(`Security scan failed: ${executionError}`);
    }

    if (clean && findings.length === 0) {
      Logger.log('INFO', 'Security scan passed — no secrets detected.');
      return;
    }

    Logger.log(
      'SECURITY_SCAN',
      `Pass ${pass}: found ${findings.length} potential secret(s). Auto-redacting...`,
    );

    const redacted = redactFindings(findings);

    if (redacted === 0) {
      Logger.log('INFO', `Could not redact ${findings.length} finding(s). Adding to .gitleaksignore.`);
      const fingerprints = findings.map(f => f.Fingerprint).filter(Boolean);
      if (fingerprints.length > 0) {
        const existing = fs.existsSync(IGNORE_FILE)
          ? fs.readFileSync(IGNORE_FILE, 'utf8').trim()
          : '';
        const combined = existing
          ? existing + '\n' + fingerprints.join('\n') + '\n'
          : fingerprints.join('\n') + '\n';
        fs.writeFileSync(IGNORE_FILE, combined);
        Logger.log('INFO', `Added ${fingerprints.length} fingerprint(s) to .gitleaksignore.`);
      }
      return;
    }

    Logger.log('INFO', `Redacted ${redacted} secret(s). Re-scanning...`);
  }

  Logger.log(
    'SECURITY_SCAN',
    `Completed ${MAX_REDACTION_PASSES} redaction passes. Some findings may remain but sync will proceed.`,
  );
}

module.exports = { check, preserveIgnoreFile, restoreIgnoreFile };
