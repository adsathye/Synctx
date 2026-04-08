# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-04-08

### Fixed

- **Git for Windows performance** — Eliminated ~12 redundant `git.exe` process spawns per sync, reducing background push latency by 5–30s on Windows
  - **Fetch deduplication** — 60-second dedup window prevents triple-fetch (daemon pre-pull, `canAmendLastCommit`, `commitAndPush`) from hitting the network 3× per sync
  - **Skip redundant `git add` + `git status`** — `commitAndPush()` now accepts pre-computed status from `sync()`, avoiding duplicate staging calls
  - **Bootstrap config check** — Reads `.git/config` directly to skip 5 `git config` process spawns when already configured
  - **Combined `git log` calls** — `canAmendLastCommit()` fetches timestamp and subject in a single `git log -1 --format=%ct%n%s` call instead of two
  - **Removed unnecessary `stash`/`pop`** — Working dir is always clean after commit; stash is now only used in daemon pre-pull where uncommitted changes may exist
  - **Non-blocking `git gc`** — Replaced synchronous `git gc --aggressive` (minutes-long) with detached `git gc` (background, 10× faster)

### Added

- **`fetchAndMerge()` helper** — Consolidates the stash→fetch→merge→pop pattern used by the daemon and `commitAndPush`, exported for reuse
- **`ensureFetched()` dedup** — Module-level fetch deduplication prevents redundant network round-trips within a 60s window

## [1.0.1] - 2026-03-06

### Fixed

- **Tombstone guard on restore/tag** — `restore` and `tag` commands now check for tombstoned (deleted) sessions and show a clear "has been deleted" error instead of allowing operations on deleted sessions
- **findSession skips tombstoned sessions** — centralized guard in `findSession()` prevents returning sessions that have been deleted, even from local CLI directory fallback
- **list filters tombstoned sessions** — `list` command now explicitly filters out tombstoned sessions from display
- **stageFiles cleans tombstoned sessions** — `stageFiles()` now proactively removes tombstoned sessions from the staging directory before copying, preventing stale data from being synced

### Added

- **list.test.js** — 9 unit tests covering `findSession()` tombstone filtering (exact match, partial match, null input, mixed live/tombstoned sessions)

## [1.0.0] - 2026-03-02

### Initial Public Release

Secure, cross-device session synchronizer for GitHub Copilot CLI and Claude Code CLI.

### Added

- **Automatic Background Sync** — 5 lifecycle hooks (sessionStart, userPromptSubmitted, postToolUse, sessionEnd, errorOccurred)
- **Gitleaks Secret Scanning** — detect → auto-redact → verify pipeline with audit trail
- **Session Tagging** — friendly names with cross-machine sync and conflict resolution
- **Session Restore** — cross-platform restore with workspace.yaml path fixup and Copilot CLI launch
- **Git-Native Merge** — stage → commit → pull/merge → push (no data loss across machines)
- **16 Commands** — sync, push, restore, list, list-copilot, list-claude, delete, prune, clean, tag, untag, tags, status, setup, uninstall, help
- **10 Skills** — sync-sessions, restore-session, list-sessions, delete-session, prune-sessions, clean-sessions, session-status, tag-session, untag-session, list-tags
- **Session Tombstones** — prevent re-sync of deleted/pruned sessions across machines
- **Global CLI** — `synctx` command via npm link
- **One-Line Installer** — setup.ps1 (Windows) and setup.sh (macOS/Linux) with auto-prerequisite installation
- **Animated Progress** — inline spinner with carriage return updates
- **24-Hour Git GC** — periodic aggressive garbage collection for disk optimization
- **Cross-Platform** — Windows (primary), macOS/Linux (upcoming)
- **Zero Dependencies** — Node.js stdlib only
- **Unit Tests** — 103 tests covering core modules
- **E2E Tests** — 69 scenarios on Windows (isolated home directory)
- **Load Tests** — 180 tests (5 users × 11 scenarios)
- **CI/CD** — GitHub Actions (Ubuntu + Windows) + npm publish workflow
- **Community Docs** — CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, issue/PR templates

