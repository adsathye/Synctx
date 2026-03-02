# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-02-26

### Added

- **Session Tombstones** — Deleted, pruned, and cleaned sessions are recorded in `.deletions.json` to prevent re-sync from other machines. Tags are automatically released when sessions are tombstoned.
- **Prune Skill** — AI-driven `prune-sessions` skill for age-based session cleanup.
- **list-copilot / list-claude Commands** — Shorthand aliases for `list --cli copilot` and `list --cli claude`.
- **Session Tagging** — Assign friendly tags to sessions (`synctx tag`, `untag`, `tags`). Tags sync across machines via `.tags.json` with automatic merge conflict resolution.
- **15 Command Definitions** — Full Copilot CLI command set: push, restore, list, list-copilot, list-claude, delete, prune, clean, status, setup, tag, untag, tags, uninstall, help.
- **9 Skills** — sync, restore, list, delete, clean, status, tag, untag, tags.
- **Git Guardrails** — All git commands sandboxed to staging directory via `gitExec()`/`gitExecStr()` wrappers with `assertSyncDir()` validation.
- **Global CLI Command** — `synctx` available system-wide via `npm link` during installation.
- **Source Change Detection** — Skips redundant syncs when no source files have changed since last push.
- **First-Run Setup Wizard** — Interactive setup on first use: checks prerequisites, prompts for repo name, bootstraps sync repository.
- **Stale Lock Recovery** — `cleanStale()` removes locks from crashed daemons on every startup.
- **Stale Index Lock Cleanup** — Automatically removes `.git/index.lock` left by crashed git operations.
- **One-Step Installer** — `node install.js` handles plugin install, global CLI link, and interactive setup.
- **Uninstaller** — `node install.js --uninstall` or `synctx uninstall` for full cleanup.
- **Cross-Platform PATH Augmentation** — Windows (winget, GitHub CLI, gitleaks), macOS (Homebrew on Apple Silicon and Intel, nvm), and Linux (snap, Linuxbrew) PATH enrichment for Copilot CLI hooks.
- **Delta Sync with Atomic Copy** — File manager copies only changed files, preserving directory structure.
- **Commit Amend Window** — Pushes within 4 hours amend the same commit to keep history clean (~6 commits/day).
- **Smart Commit Messages** — Dynamically reports which CLI triggered the change (Copilot, Claude, or both).
- **Audit Logging** — All operations logged to `~/.synctx/security-audit/general.log` with structured metadata.
- **Gitleaks Auto-Redaction** — Detected secrets are automatically redacted before push, with a full audit trail.
- **Community Docs** — CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md, issue/PR templates.
- Dry-run mode (`status`) for safe configuration validation.
- `package.json` with npm scripts, bin entry, and release automation.
- `.gitignore`, `.editorconfig`, `.npmignore` for clean repository hygiene.
- MIT License.
- Comprehensive JSDoc documentation throughout all modules.

### Fixed

- **Multi-Machine Bootstrap** — Fixed `.gitignore` being written before `git checkout`, causing "untracked working tree files would be overwritten" error when bootstrapping a second machine against an existing remote repository.
- **Clean Command Tag Release** — `clean` now releases ALL tags unconditionally (full wipe), not just tags matching scanned sessions. Previously, orphaned tags from sessions staged on other machines could persist after a clean.
- **Prune --days 0** — Fixed `prune --days 0` defaulting to 90 days due to JavaScript falsy `0` in `||` operator. Now uses `!= null` check.
- **Non-Interactive Mode** — Added `SYNCTX_NONINTERACTIVE` env var to auto-confirm destructive operations in CI/test environments. Confirmation prompts now correctly read from piped stdin when set.

### Added

- **E2E Test Suite** — 69 Docker-based end-to-end tests covering all 16 CLI commands, restore flow, tag operations, destructive ops with confirmation, cross-machine sync, hook simulation, gitleaks security scan, and edge cases. Runs on both macOS and Linux.
- **Installation Tracking** — GitHub Actions workflow saves daily traffic/clone data to `traffic-data` branch for long-term installation analytics (GitHub only retains 14 days natively).
