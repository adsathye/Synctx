'use strict';

/**
 * @module confirm
 * @description Interactive confirmation for destructive operations.
 *
 * All prompts show a clear default in brackets. Pressing Enter
 * always takes the default — never skips or cancels unexpectedly.
 *
 * @license MIT
 */

const readline = require('readline');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a readable input stream for prompts.
 * Falls back to /dev/tty when stdin is piped (e.g., curl | bash).
 *
 * @returns {{ input: NodeJS.ReadableStream, cleanup: () => void }}
 */
function getTerminalInput() {
  // In CI/test mode, always read from stdin to support piped input
  if (process.stdin.isTTY || process.env.SYNCTX_NONINTERACTIVE) {
    return { input: process.stdin, cleanup() {} };
  }
  try {
    const input = fs.createReadStream('/dev/tty');
    return { input, cleanup() { try { input.close(); } catch { /* best-effort */ } } };
  } catch {
    return { input: process.stdin, cleanup() {} };
  }
}

/**
 * Prompt the user with a question and wait for a yes/no answer.
 *
 * @param {string} question — The question to display.
 * @param {boolean} [defaultYes=true] — Default answer when Enter is pressed.
 * @returns {Promise<boolean>} true if the user confirmed.
 */
function askYesNo(question, defaultYes = true) {
  // In non-interactive/CI mode, auto-confirm with default
  if (process.env.SYNCTX_NONINTERACTIVE) {
    const answer = defaultYes ? 'yes' : 'no';
    console.log(`${question} (${defaultYes ? 'Y/n' : 'y/N'}): ${answer} [auto]`);
    return Promise.resolve(defaultYes);
  }
  const hint = defaultYes ? '(Y/n)' : '(y/N)';
  return new Promise((resolve) => {
    const { input, cleanup } = getTerminalInput();
    const rl = readline.createInterface({
      input,
      output: process.stdout,
    });

    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      cleanup();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') return resolve(defaultYes);
      resolve(trimmed === 'yes' || trimmed === 'y');
    });
  });
}

/**
 * Double-confirmation for destructive operations.
 *
 * Prompts the user twice — first with a description of what will happen,
 * then with a final "are you sure" confirmation. Both default to yes
 * since the user explicitly invoked the destructive command.
 *
 * @param {string} description — What the operation will do.
 * @returns {Promise<boolean>} true only if both confirmations pass.
 */
async function doubleConfirm(description) {
  console.log(`\n[warn] ${description}\n`);

  const first = await askYesNo('Do you want to proceed?', true);
  if (!first) {
    console.log('[error] Operation cancelled.');
    return false;
  }

  const second = await askYesNo('[warn] This cannot be undone. Are you sure?', true);
  if (!second) {
    console.log('[error] Operation cancelled.');
    return false;
  }

  return true;
}

module.exports = { askYesNo, doubleConfirm };
