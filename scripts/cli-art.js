/**
 * @module cli-art
 * @description Prints the Synctx banner with true color ANSI codes.
 * Colors extracted from logo.png.
 * @license MIT
 */

'use strict';

function printBanner() {
  const tl = '\x1b[38;2;90;170;194m';   // teal #5aaac2
  const bl = '\x1b[38;2;74;73;172m';    // purple-blue #4a49ac
  const or = '\x1b[38;2;255;154;78m';   // orange #ff9a4e
  const dm = '\x1b[2m';
  const r = '\x1b[0m';

  const lines = [
    '',
    tl + '   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2557   \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557  \u2588\u2588\u2557' + r,
    tl + '   \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u255a\u2588\u2588\u2557 \u2588\u2588\u2554\u255d\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255d\u255a\u2588\u2588\u2557\u2588\u2588\u2554\u255d' + r,
    bl + '   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u255a\u2588\u2588\u2588\u2588\u2554\u255d \u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2551        \u2588\u2588\u2551    \u255a\u2588\u2588\u2588\u2554\u255d' + r,
    bl + '   \u255a\u2550\u2550\u2550\u2550\u2588\u2588\u2551  \u255a\u2588\u2588\u2554\u255d  \u2588\u2588\u2551\u255a\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2551        \u2588\u2588\u2551    \u2588\u2588\u2554\u2588\u2588\u2557' + r,
    or + '   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2551 \u255a\u2588\u2588\u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2557   \u2588\u2588\u2551   \u2588\u2588\u2554\u255d \u2588\u2588\u2557' + r,
    or + '   \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d   \u255a\u2550\u255d   \u255a\u2550\u255d  \u255a\u2550\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d   \u255a\u2550\u255d   \u255a\u2550\u255d  \u255a\u2550\u255d' + r,
    '',
    dm + '   Sync your AI coding sessions across devices \u2014 securely.' + r,
    '',
  ];

  const out = lines.join('\n') + '\n';
  if (process.stdout && process.stdout.isTTY) {
    process.stdout.write(out);
  } else {
    console.log(out.replace(/\x1b\[[0-9;]*m/g, ''));
  }
}

module.exports = { printBanner };
