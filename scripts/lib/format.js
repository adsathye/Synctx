'use strict';

/**
 * @module format
 * @description Formatting, ANSI color, and inline progress utilities.
 *
 * @license MIT
 */

const { spawn } = require('child_process');

// ANSI color codes — logo colors
const c = {
  teal: '\x1b[38;2;90;170;194m',
  blue: '\x1b[38;2;74;73;172m',
  orange: '\x1b[38;2;255;154;78m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

/**
 * Inline progress with animated spinner.
 * Spawns a child process so the animation runs even when the parent's
 * event loop is blocked by execSync / execFileSync.
 *
 * Usage:
 *   const p = progress('Syncing');
 *   p.update('Pulling from remote...');
 *   p.done('Sync complete');       // green ✓
 *   p.fail('Push failed');         // red ✗
 */
function progress(label) {
  const isTTY = process.stdout && process.stdout.isTTY;
  const clear = isTTY ? `\r\x1b[K` : '';
  let spinnerProc = null;

  function startSpinner(msg) {
    stopSpinner();
    if (!isTTY) {
      process.stdout.write(`  - ${msg}\n`);
      return;
    }
    // Spawn a child process for the spinner animation.
    // execSync blocks the parent event loop, preventing setInterval
    // from firing. A separate process has its own event loop.
    const script = [
      `const f=['\\u280b','\\u2819','\\u2839','\\u2838','\\u283c','\\u2834','\\u2826','\\u2827','\\u2807','\\u280f'];`,
      `let i=0;const m=${JSON.stringify(msg)};`,
      `process.stdout.write('\\r\\x1b[K  \\x1b[38;2;90;170;194m'+f[0]+'\\x1b[0m '+m);`,
      `const t=setInterval(()=>{i++;process.stdout.write('\\r\\x1b[K  \\x1b[38;2;90;170;194m'+f[i%f.length]+'\\x1b[0m '+m);},80);`,
      `setTimeout(()=>{clearInterval(t);process.exit();},60000);`,
    ].join('');
    spinnerProc = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', process.stdout, 'ignore'],
      windowsHide: true,
    });
    spinnerProc.unref();
  }

  function stopSpinner() {
    if (spinnerProc) {
      try { spinnerProc.kill(); } catch { /* already exited */ }
      spinnerProc = null;
    }
  }

  return {
    update(msg) {
      startSpinner(msg);
    },
    done(msg) {
      stopSpinner();
      if (isTTY) {
        process.stdout.write(`${clear}  ${c.green}✓${c.reset} ${msg || label}\n`);
      } else {
        console.log(`  ✓ ${msg || label}`);
      }
    },
    fail(msg) {
      stopSpinner();
      if (isTTY) {
        process.stdout.write(`${clear}  ${c.red}✗${c.reset} ${msg || label}\n`);
      } else {
        console.log(`  ✗ ${msg || label}`);
      }
    },
    skip(msg) {
      stopSpinner();
      if (isTTY) {
        process.stdout.write(`${clear}  ${c.yellow}[-]${c.reset} ${msg || label}\n`);
      } else {
        console.log(`  [-] ${msg || label}`);
      }
    },
  };
}

module.exports = { formatBytes, c, progress };