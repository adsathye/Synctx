# Synctx — Agent Guidelines

This file helps AI coding agents (Copilot CLI, Claude Code, etc.) work effectively in this repository.

## Project Overview

Synctx is a Copilot CLI plugin that syncs AI session data across devices via a private Git repository with Gitleaks secret scanning. Zero npm dependencies — Node.js stdlib only.

## Architecture

```
scripts/sync-engine.js          → Entry point, command router, daemon
scripts/lib/config.js           → Central config, CLI path mappings
scripts/lib/git-manager.js      → Git lifecycle (bootstrap, sync, restore)
scripts/lib/file-manager.js     → Delta copy, atomic writes
scripts/lib/security.js         → Gitleaks detect → redact → verify
scripts/lib/lock.js             → PID-aware concurrency lock
scripts/lib/logger.js           → Audit logging
scripts/lib/tags.js             → Session tagging (.tags.json)
scripts/lib/tombstones.js       → Deletion manifest (.deletions.json)
scripts/lib/commands/{list,delete,prune}.js → Command implementations
```

## Key Constraints

- **No npm dependencies** — only Node.js built-in modules (fs, path, os, child_process)
- **Cross-platform** — all file paths must use `path.join()`, never hardcoded separators
- **Git guardrails** — all git commands must use `gitExec()` or `gitExecStr()` which enforce `cwd: CONFIG.syncDir`
- **Never modify user session dirs** — `~/.copilot/` and `~/.claude/` are read-only sources; all writes go to `~/.synctx/`
- **Secrets** — never log, commit, or output credentials. Gitleaks scans all staged files before push

## Mandatory: Update Docs and Tests with Every Code Change

After any code change, you **must** also update:

1. **Documentation** — README.md, GUIDE.md, CHANGELOG.md, and any affected command `.md` or skill `SKILL.md` files
2. **Help text** — the `showHelp()` function in sync-engine.js if commands, options, or examples changed
3. **Tests** — run `npm run lint` and `npm test` to verify nothing is broken
4. **AGENTS.md** — if architecture, constraints, or conventions changed

Do not consider a change complete until docs, references, and tests are all consistent with the new code.

## Mandatory: Cross-Platform Parity

Synctx supports Windows, macOS, and Linux. When making changes:

1. **hooks.json** — if you add or change a hook, provide both `bash` (macOS/Linux) and `powershell` (Windows) keys
2. **setup.ps1 / setup.sh** — any change to the install flow in one script must have an equivalent change in the other
3. **Path handling** — never use hardcoded path separators. Use `path.join()` in JS, `$HOME` in shell scripts
4. **Package managers** — if a new dependency or tool is introduced, add install logic for winget (Windows), brew (macOS), and apt-get (Linux)
5. **Shell commands** — if using platform-specific commands (e.g., `where` vs `which`), guard with `os.platform()` checks
6. **Test on both** — at minimum, run `npm run lint` and `npm test` on the platform you changed, and verify the other platform's scripts are consistent

## Testing

```bash
npm run lint    # Syntax check all JS files
npm test        # Status check (no side effects)
synctx --version
```

## Naming Conventions

- Package/CLI: `synctx` (lowercase)
- Display: `Synctx` (title case)
- Env vars: `SYNCTX_*` (screaming snake)
- Sync dir: `~/.synctx/`
