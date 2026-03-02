# Synctx — Detailed Guide

This guide covers everything about how Synctx works under the hood: architecture, sync pipeline, security, configuration, troubleshooting, and more.

For installation and quick start, see the [README](README.md).

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Sync Pipeline](#sync-pipeline)
- [Security](#security)
- [Commands Reference](#commands-reference)
- [Session Tagging](#session-tagging)
- [Skills Reference](#skills-reference)
- [Configuration](#configuration)
- [Directory Structure](#directory-structure)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Uninstalling](#uninstalling)

---

## Features

- **Automatic Background Sync** — Sessions sync invisibly on session end and after tool use via lifecycle hooks. Your terminal is never blocked.
- **Animated Progress Indicators** — All interactive commands show animated spinner progress (child-process based, so animation runs even during blocking git/gitleaks operations). Non-TTY environments get static status lines.
- **Professional CLI Output** — All output uses standard text indicators (`[ok]`, `[error]`, `[warn]`, `[sync]`, `[info]`, `✓`, `✗`) instead of emoji.
- **Seamless Hot-Reloading** — Restore past conversations into active AI memory, letting you resume where you left off without restarting the terminal.
- **Multi-CLI Support** — Works with both GitHub Copilot CLI and Claude Code. Each CLI's state is isolated into separate Git namespaces.
- **Strict Schema Mapping** — Restored sessions are placed exactly where the host CLI expects them, using deterministic path mapping across Windows, macOS, and Linux.
- **Secret Scanning** — Every sync is scanned by [Gitleaks](https://github.com/gitleaks/gitleaks). Detected secrets are automatically redacted — sync always proceeds.
- **Delta Sync** — Only changed files are copied. Unchanged files are skipped entirely.
- **Concurrency Safe** — PID-aware lock file with 5-minute debounce prevents concurrent syncs across multiple terminals.
- **Crash Resilient** — Stale locks are auto-recovered, `.last_sync` is written only after successful push, and git index locks are auto-cleaned.
- **Commit Amend Window** — Pushes within a 4-hour window amend the same commit instead of creating hundreds, keeping your sync repo clean.
- **Audit Logging** — All actions are timestamped and logged per-CLI with separate redaction reports.
- **Cross-Platform** — Works on Windows, macOS, and Linux with OS-specific PATH augmentation (Homebrew, nvm, snap, winget, and other common tool locations are auto-detected when Copilot CLI hooks run with a stripped PATH).

> Synctx supports **Windows**, **macOS**, and **Linux** with full PATH augmentation for Copilot CLI hooks.

- **Zero Dependencies** — Pure Node.js stdlib — no npm dependencies to install or maintain.

---

## How It Works

Synctx installs lifecycle hooks into your AI CLI. When a session ends or a tool is used, the plugin spawns a background daemon that:

```
Hook fires (sessionStart / userPromptSubmitted / postToolUse / sessionEnd / errorOccurred)
  → sessionStart: auto-setup (bootstrap repo if needed)
  → All others: Daemon spawns (non-blocking, detached)
    → Acquires lock (PID-based, 5-min debounce)
      → Delta-copies session files to staging directory
        → Gitleaks scans staged files for secrets
          → Auto-redacts any findings (3-pass max)
            → Git commit + push to private repo
              → Writes .last_sync timestamp
                → Releases lock
```

The daemon runs completely detached — your terminal prompt returns immediately.

---

## Sync Pipeline

### 1. Hook Trigger

Hooks are defined in `hooks.json` and fire on five lifecycle events:

| Hook | When it fires | Action |
|------|--------------|--------|
| `sessionStart` | When a CLI session opens | Runs `auto-setup.js` (silent bootstrap, ensures repo exists) |
| `userPromptSubmitted` | After the user submits a prompt | Background push to remote |
| `postToolUse` | After any tool execution | Background push to remote |
| `sessionEnd` | When a CLI session closes | Background push to remote |
| `errorOccurred` | When an error occurs in the CLI | Background push to remote (preserves context before crash) |

### 2. Lock Acquisition

Before syncing, the engine acquires a PID-based lock file (`~/.synctx/.sync_lock`):

- **5-minute debounce** — If a sync completed within the last 5 minutes, the new sync is skipped.
- **PID ownership** — The lock includes the owning process ID. If the PID is no longer running, the lock is considered stale and auto-recovered.
- **Atomic creation** — Uses `O_CREAT | O_EXCL` flags for safe concurrent access.

### 3. Delta Copy

Files are copied from source CLI directories to the staging directory using delta sync:

- Only files with different size or modification time are copied.
- Deletions in the source are NOT mirrored to staging (to preserve other machines' sessions in multi-device setups). Use `delete` or `prune` to remove old sessions explicitly.
- Copies are atomic: written to `.tmp` then renamed.
- **Source directories are never modified** — all writes go to the staging directory only.

**Source directories by CLI:**

| CLI | Source paths |
|-----|-------------|
| GitHub Copilot | `~/.copilot/session-state/`, `~/.copilot/history-session-state/` |
| Claude Code | `~/.claude/projects/`, `~/.claude/todos/` |

### 4. Secret Scanning

Every staged file is scanned by Gitleaks before being committed:

1. **Detect** — `gitleaks detect` runs on the staging directory.
2. **Redact** — Any detected secrets are replaced with `[REDACTED-{ruleId}]` in the file.
3. **Verify** — A second scan confirms all secrets were redacted. Up to 3 passes if needed.
4. **Report** — Per-session JSON redaction reports are saved to `security-audit/{cli}/{session-id}.json`.

Fingerprints of known findings are auto-added to `.gitleaksignore` to prevent repeated alerts.

### 5. Git Commit & Push

- Commits use the **4-hour amend window**: if the last commit was within 4 hours and hasn't been pushed by another device, the new changes amend that commit.
- This keeps the sync repo clean with ~6 commits/day instead of hundreds.
- Before amending, the engine does a `git fetch` and compares local HEAD with remote HEAD to avoid overwriting changes from other devices.
- Force-push (`--force-with-lease`) is used for amended commits.

---

## Security

### Gitleaks Integration

Gitleaks is a **mandatory prerequisite**. The plugin will not sync without it.

The detect → redact → verify pipeline ensures no secrets ever reach your sync repository:

```
Staged files → gitleaks detect → findings?
  → Yes: Replace each secret with [REDACTED-{ruleId}]
       → gitleaks detect again (verify)
       → Still findings? Retry up to 3 times
       → Log all redactions to audit
  → No: Proceed to commit
```

### What Gets Redacted

Gitleaks detects a wide range of secrets including access keys, authentication tokens, API keys, connection strings, private keys, and generic high-entropy strings. Any detected secret is replaced inline:

```
Before: "api_key": "sk-1234567890abcdef"
After:  "api_key": "[REDACTED-generic-api-key]"
```

### Audit Logging

All events are logged with ISO timestamps:

| Log file | Contents |
|----------|----------|
| `security-audit/general.log` | All events across both CLIs |
| `security-audit/copilot/copilot.log` | Copilot-specific sync events |
| `security-audit/claude/claude.log` | Claude-specific sync events |
| `security-audit/redactions.log` | All secret redactions |
| `security-audit/{cli}/{session}.json` | Per-session redaction reports |

### Private Repository

The sync repository (`.synctx`) is created as a **private** GitHub repository using the `gh` CLI. Only you have access.

### Authentication

Synctx delegates all authentication to the GitHub CLI (`gh`):

1. **Prerequisite** — User runs `gh auth login` once (checked during setup).
2. **Credential helper** — `bootstrap()` sets `credential.helper = !gh auth git-credential` (local to the sync repo only). This allows `git push/pull` to authenticate via `gh` without prompting.
3. **No credentials stored** — Synctx never handles passwords, tokens, or SSH keys directly.

### Commit Identity

Sync commits use a dedicated local identity (`Synctx <synctx@noreply>`) set during `bootstrap()`. This is scoped to the sync repo only — your global git config and other repositories are not affected.

---

## Commands Reference

All commands are available in three ways:

| Method | Example |
|--------|---------|
| **Copilot CLI slash command** | `/synctx push` |
| **Global terminal command** | `synctx push` |
| **Node.js direct** | `node ./scripts/sync-engine.js push` |

### Sync

Full bidirectional sync — pulls from remote, stages local sessions, scans for secrets, and pushes.

```
/synctx sync
```
```bash
synctx sync
```

This is the primary command for manual syncing. It runs interactively with animated progress spinners for each step:
1. Pulls latest sessions from remote (other machines)
2. Stages local CLI session files
3. Scans with Gitleaks and auto-redacts secrets
4. Pushes everything to the remote sync repo

### Push

Push local sessions to remote in the background.

```
/synctx push
```
```bash
synctx push
```

Runs as a detached background daemon — your terminal returns immediately. Used by hooks for automatic syncing. For interactive full sync, use `sync` instead.

### Restore

Pull synced sessions from the remote and optionally restore a specific session.

```
/synctx restore
```
```bash
synctx restore [<tag-or-session-id>]
```

**Without arguments:** Pulls the latest data into the staging directory.

**With a tag or session ID:** Pulls data, then copies the session back to the CLI's session directory so you can use `/resume <id>` to switch to it.

```bash
synctx restore plugin-build          # Restore by tag
synctx restore e0e9f4b8              # Restore by partial ID
```

**Two restore modes in Copilot CLI:**

- **Hot-load (Option A):** Reads the old session's context into the current conversation. Session ID stays the same — this is context injection, not a session switch. If the restored session had a tag (e.g., `auth-refactor`), the current session is auto-tagged as `auth-refactor-continued`.
- **Prepare for /resume (Option B):** Copies session files back to the CLI directory. Run `/resume <id>` to switch to the original session with its full history.

### List Sessions

```
/synctx list            # All sessions
/synctx list-copilot    # Copilot sessions only
/synctx list-claude     # Claude sessions only
```
```bash
synctx list [--cli copilot|claude]
```

Shows session ID, CLI type, file count, size, and last modified date. Pulls latest from remote (with progress spinner) before listing.

### Delete Session

```
/synctx delete
```
```bash
synctx delete <session-id-or-tag> [--cli copilot|claude]
```

Requires double confirmation. Syncs the deletion to the remote sync repo with a progress spinner. Supports:
- Full session ID: `synctx delete e0e9f4b8-495b-4db7-a997-e03abb610a62`
- Partial UUID: `synctx delete e0e9f4`
- Tag name: `synctx delete my-tag`

### Prune Old Sessions

```
/synctx prune
```
```bash
synctx prune [--days 30] [--cli copilot|claude]
```

Removes sessions older than the specified retention period (default: 90 days). Requires confirmation. Syncs the cleanup to the remote repository.

### Clean Local State

```
/synctx clean
```
```bash
synctx clean
```

Removes all synced session data from the local staging directory (`~/.synctx/`). Original CLI session directories are **not** affected. The cleanup is pushed to the remote. Requires double confirmation.

> **Note:** On a multi-machine setup, other machines will re-push their sessions on the next sync cycle.

### Tag a Session

```
/synctx tag
```
```bash
synctx tag <session-id> <tag-name>
```

Assigns a friendly, memorable tag to a session. Tags must be 2–50 characters, lowercase alphanumeric with hyphens/underscores (e.g., `auth-refactor`, `api_v2`).

If the tag already exists on another machine for a different session, the tag is auto-suffixed with the hostname to prevent conflicts.

### Remove a Tag

```
/synctx untag
```
```bash
synctx untag <tag-name>
```

Removes a tag. The session itself is not affected.

### List Tags

```
/synctx tags
```
```bash
synctx tags
```

Shows all session tags with their session IDs and CLI type.

### Status

```
/synctx status
```
```bash
synctx status
```

Shows sync directory, audit log path, prerequisites check (Node.js, Git, gh, Gitleaks), and CLI source paths with existence checks. Source directories that don't exist yet (e.g., legacy paths or unused CLIs) are shown as `[--] (not found)` instead of errors. Remote sync status is fetched with an animated spinner.

### Setup

```
/synctx setup
```
```bash
synctx setup
```

Runs the first-time interactive setup wizard: checks prerequisites, prompts for sync repository name, bootstraps the private GitHub repo, and performs the first sync with separate progress indicators for staging, security scanning, and push. When installed via `curl | bash`, prompts automatically use `/dev/tty` to read from the terminal.

### Uninstall

```
/synctx uninstall
```
```bash
synctx uninstall
```

Removes the staging directory, audit logs, configuration, and optionally the remote GitHub repository. Also removes Claude Code hooks if installed.

### Help

```
/synctx help
```
```bash
synctx help
```

Shows all available commands, options, and usage examples.

### Version

```bash
synctx --version
synctx -v
```

Displays the installed Synctx version.

---

## Session Tagging

Tags are friendly, human-readable aliases for session IDs. They sync across all your machines via the same git-backed sync mechanism.

### How It Works

Tags are stored in `~/.synctx/.tags.json` — a single JSON manifest that syncs across machines:

```json
{
  "auth-refactor": {
    "cli": "github-copilot",
    "sessionId": "e0e9f4b8-495b-4db7-a997-e03abb610a62",
    "createdAt": "2026-02-25T19:00:00.000Z"
  }
}
```

### Tag Rules

- **2–50 characters**, lowercase alphanumeric with hyphens and underscores
- Must be **unique** across all sessions (both CLIs)
- Case-insensitive matching, stored lowercase
- Cannot look like a UUID (to avoid ambiguity with session IDs)

### Using Tags with Other Commands

Tags work anywhere a session ID is accepted:

```bash
synctx restore auth-refactor     # Restore by tag
synctx delete auth-refactor      # Delete by tag
```

### Multi-Machine Conflict Resolution

If the same tag is assigned to different sessions on different machines:

1. On sync, git merges the `.tags.json` changes
2. If a merge conflict occurs, both sides are kept — the newer assignment gets the tag, and the older one is auto-suffixed with the hostname (e.g., `auth-refactor-laptop`)
3. Assigning a tag also pulls latest tags from remote first to detect conflicts early

### Session Tombstones (Deletion Protection)

When you delete, prune, or clean sessions, Synctx records a **tombstone** in `.deletions.json`. This prevents deleted sessions from being re-synced back from other machines.

**How it works:**

1. Machine A deletes session `abc-123` via `synctx delete abc-123`
2. Synctx records `abc-123` in `.deletions.json` and pushes to remote
3. Machine B pulls the updated `.deletions.json` on next sync
4. Machine B's `stageFiles()` skips `abc-123` even if it still exists locally
5. The session stays in Machine B's local CLI directory but is never re-pushed

**Tombstone triggers:**

| Command | Behavior |
|---------|----------|
| `synctx delete <session>` | Tombstones the specific session, releases its tags |
| `synctx prune --days N` | Tombstones all pruned sessions, releases their tags |
| `synctx clean` | Tombstones ALL sessions in staging, releases all tags |

**Tag release:** When a session is tombstoned, any tags pointing to it are automatically removed. The tag name becomes available for reuse on any machine.

**Tombstone file:** `.deletions.json` is committed to the sync repo (NOT in `.gitignore`) so it propagates across all machines via git.

### Continuation Tags

When you hot-load a tagged session into the current conversation (Option A in restore), Synctx automatically creates a continuation tag:

- Original session: `auth-refactor` → `e0e9f4b8-...`
- Current session: `auth-refactor-continued` → `3ff1181a-...`

This creates a chain of related sessions that you can follow across devices and time.

---

## Skills Reference

Skills are AI-driven workflows that the agent executes on your behalf inside Copilot CLI. Unlike commands (which map to shell scripts), skills provide natural language instructions that the AI follows.

### sync-sessions

**Trigger:** Ask the AI to sync, push, or save your sessions.

Runs the full sync pipeline: acquires lock → delta-copies files → scans for secrets → auto-redacts → pushes to remote. Runs as a background daemon.

### restore-session

**Trigger:** Ask the AI to restore a previous session or load context.

Pulls the latest data, then hot-loads a session's conversation data directly into the AI's active memory. The AI reads checkpoints, turns, and context files to resume exactly where you left off — no manual copy-paste needed.

> **Important:** This is a "hot-reload" — the session data is read into the current conversation context, not restored to the original CLI directory.

### list-sessions

**Trigger:** Ask the AI to list or show your sessions.

Displays all synced sessions with metadata (file count, size, last modified). Supports filtering by CLI (`--cli copilot|claude`).

### delete-session

**Trigger:** Ask the AI to delete a specific session.

Accepts session ID, partial UUID, or tag name. Requires double confirmation before deleting. The deleted session is tombstoned — it will not be re-synced from other machines. Any tags pointing to the session are released. Syncs the deletion to the remote sync repo.

### prune-sessions

**Trigger:** Ask the AI to prune old sessions or clean up by age.

Deletes sessions older than a specified number of days (default: 90). Optionally filters by CLI. Lists affected sessions, requires double confirmation. All pruned sessions are tombstoned and their tags released.

### clean-sessions

**Trigger:** Ask the AI to clean or wipe the staging directory.

Removes all synced session data from the local staging directory. All sessions are tombstoned — they will NOT be re-synced from any machine. Any tags are released. The cleanup is pushed to remote. Requires double confirmation.

> **Note:** Original CLI session directories are never modified.

### session-status

**Trigger:** Ask the AI about sync status or configuration.

Shows platform info, staging directory path, audit log location, all configured CLI source paths with existence checks, and prerequisite verification (Node.js, Git, gh, Gitleaks).

### tag-session

**Trigger:** Ask the AI to tag a session with a friendly name.

Lists sessions, asks which one to tag and what name to use, then assigns the tag. Supports full/partial session IDs and the keyword "current". Tags sync across machines and can be used with `restore`, `delete`, and other commands.

### untag-session

**Trigger:** Ask the AI to remove a tag.

Lists existing tags, asks which to remove, then removes it. The session itself is not deleted — only the friendly alias is removed.

### list-tags

**Trigger:** Ask the AI to show all tags.

Displays all session tags with their session IDs and CLI type. Pulls latest from remote first so tags from all machines are included.

---

## Configuration

Configuration is managed via environment variables with sensible defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNCTX_GIT_HOST` | `github.com` | Git host for the sync repository |
| `SYNCTX_SYNC_DIR` | `~/.synctx` | Local staging directory |
| `SYNCTX_REPO_NAME` | `.synctx` | sync repository name on GitHub |
| `SYNCTX_LOCK_TTL` | `300000` (5 min) | Lock debounce window in milliseconds |
| `SYNCTX_COMMIT_WINDOW` | `14400000` (4 hr) | Commit amend window in milliseconds |
| `SYNCTX_BRANCH` | `main` | Git branch name |

### User Config

During first-time setup (`postinstall.js`), your chosen repository name is saved to `~/.synctx/.config.json`. This persists across reinstalls.

---

## Directory Structure

### Plugin Structure

```
synctx/
├── plugin.json                     # Copilot CLI plugin manifest
├── .claude-plugin/
│   └── plugin.json                 # Claude Code plugin manifest
├── hooks.json                      # Lifecycle hooks (sessionStart, userPromptSubmitted, postToolUse, sessionEnd, errorOccurred)
├── package.json                    # npm manifest (version source of truth)
├── install.js                      # One-step installer
├── setup.sh / setup.ps1            # One-liner install scripts (curl | bash / irm | iex)
├── publish.sh / publish.ps1        # Publish scripts
├── README.md                       # Quick start guide
├── GUIDE.md                        # This file
├── AGENTS.md                       # AI coding agent guidelines
├── CHANGELOG.md                    # Version history
├── CONTRIBUTING.md                 # Contributor guidelines
├── CODE_OF_CONDUCT.md              # Contributor Covenant
├── SECURITY.md                     # Security policy and architecture
├── LICENSE                         # MIT License
├── .github/
│   ├── ISSUE_TEMPLATE/             # Bug report and feature request templates
│   └── pull_request_template.md    # PR template
├── agents/
│   └── synctx.agent.md             # Agent definition
├── skills/                         # 10 skill definitions
│   ├── sync/SKILL.md
│   ├── restore/SKILL.md
│   ├── list/SKILL.md
│   ├── delete/SKILL.md
│   ├── prune/SKILL.md
│   ├── clean/SKILL.md
│   ├── status/SKILL.md
│   ├── tag/SKILL.md
│   ├── untag/SKILL.md
│   └── tags/SKILL.md
├── commands/                       # 16 command definitions
│   ├── sync.md, push.md, restore.md, list.md
│   ├── list-copilot.md, list-claude.md
│   ├── delete.md, prune.md, clean.md
│   ├── tag.md, untag.md, tags.md
│   ├── status.md, setup.md
│   ├── uninstall.md, help.md
└── scripts/
    ├── sync-engine.js              # CLI entry point and command router
    ├── auto-setup.js               # Session-start hook handler
    ├── cli-art.js                  # ASCII banner art
    ├── setup.js                    # Claude Code hook installer
    ├── postinstall.js              # First-time setup wizard
    ├── uninstall.js                # Cleanup and removal script
    ├── version-sync.js             # Version propagation script
    └── lib/
        ├── config.js               # Central configuration
        ├── cli-detect.js            # CLI detection and filtering
        ├── file-manager.js          # Delta sync and atomic copy
        ├── security.js              # Gitleaks detect → redact → verify
        ├── git-manager.js           # Git bootstrap, sync, commit, push
        ├── lock.js                  # PID-aware atomic lock
        ├── logger.js                # Per-CLI audit logging
        ├── tags.js                  # Session tagging system
        ├── tombstones.js            # Deletion manifest (prevents re-sync)
        ├── confirm.js               # User confirmation prompts (/dev/tty fallback)
        ├── format.js                # Output formatting, child-process spinner
        └── commands/                # Command implementations
            ├── list.js
            ├── delete.js
            └── prune.js
```

### Staging Directory (Runtime)

```
~/.synctx/
├── .git/                                    # Private sync repository
├── .config.json                             # User configuration
├── .tags.json                               # Session tag manifest (syncs across machines)
├── .deletions.json                          # Tombstone manifest (syncs across machines)
├── .last_sync                               # Timestamp of last successful push
├── .sync_lock                               # PID-based lock file (transient)
├── .gitleaksignore                          # Known secret fingerprints
├── .gitignore                               # Excludes operational files (.last_sync, .DS_Store, audit logs)
├── security-audit/
│   ├── general.log                          # All events
│   ├── redactions.log                       # All secret redactions
│   ├── copilot/
│   │   ├── copilot.log                      # Copilot sync events
│   │   └── {session-id}.json                # Per-session redaction reports
│   └── claude/
│       ├── claude.log                       # Claude sync events
│       └── {session-id}.json                # Per-session redaction reports
├── github-copilot/
│   ├── session-state/                       # Synced Copilot sessions
│   └── history-session-state/               # Synced Copilot legacy sessions
└── claude/
    ├── projects/                            # Synced Claude project sessions
    └── todos/                               # Synced Claude todos
```

---

## Troubleshooting

### Gitleaks blocks my sync / false positives

Secrets are auto-redacted with `[REDACTED-{ruleId}]` — sync always proceeds. Fingerprints are auto-added to `.gitleaksignore`. Check `security-audit/redactions.log` for details.

### Sync seems slow

Delta sync only copies changed files. If your sync repo has grown large, run `prune --days 30` to remove old sessions.

### Plugin not syncing automatically

Hooks only load when the plugin is first detected by the CLI. Restart your terminal after installing the plugin.

### Lock appears stuck

The lock auto-recovers if the owning PID is no longer running. If needed, delete `~/.synctx/.sync_lock` manually.

### Missing prerequisites

Run `/synctx status` to check which prerequisites are installed. Gitleaks is required — the plugin will not sync without it.

### Tools not found on macOS

Synctx auto-detects Homebrew paths (`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin` on Intel) and nvm-managed Node.js. If tools like `gh` or `gitleaks` are installed in non-standard locations, add them to your PATH or set the `SYNCTX_SYNC_DIR` environment variable.

### Multiple devices

The 4-hour amend window uses `git fetch` to check if the remote has diverged before amending. If another device pushed, a new commit is created instead.

### Git push/pull failures

Push and pull errors include the actual git stderr in the error message (e.g., `Git push failed: ... — error: failed to push some refs`). Check the audit log for details:

```bash
tail -20 ~/.synctx/security-audit/general.log
```

Common causes:
- **Expired `gh` auth** — run `gh auth login` to re-authenticate
- **Network issues** — sync will retry automatically on next hook trigger
- **First push on a new machine** — Synctx handles diverged histories automatically with `--allow-unrelated-histories`

---

## Testing

### Test 1: Status Check

```bash
synctx status
```

Verify all prerequisites are detected and CLI source paths are shown.

### Test 2: Bootstrapper

```bash
synctx push
ls ~/.synctx/.git  # Should exist
```

Verify a private sync repository was created on your GitHub account.

### Test 3: Security Gate

```bash
# Create a dummy session file with a fake secret
mkdir -p ~/.copilot/session-state/test-folder
echo '{"key": "AKIAIOSFODNN7EXAMPLE"}' > ~/.copilot/session-state/test-folder/test.json

# Run sync
synctx push

# Verify the secret was redacted
cat ~/.synctx/github-copilot/session-state/test-folder/test.json
# Should show: {"key": "[REDACTED-generic-api-key]"}

# Check audit log
tail -5 ~/.synctx/security-audit/general.log
```

### Test 4: Session Tagging

```bash
synctx list                          # Find a session ID
synctx tag <session-id> test-tag     # Assign a tag
synctx tags                          # Verify tag shows up
synctx untag test-tag                # Clean up
```

### Test 5: Hot-Reload Restore

```
/synctx restore
```

Follow the prompts to select and hot-load a previous session into AI memory.

---

## Uninstalling

### Quick Uninstall

```bash
synctx uninstall
```

This removes the staging directory, configuration, and optionally the remote repository.

### Manual Uninstall

#### GitHub Copilot CLI

```bash
copilot plugin uninstall synctx
```

#### Claude Code

```bash
node ./scripts/setup.js uninstall
```

#### Remove global CLI command

```bash
npm unlink -g synctx
```

#### Remove synced data

```bash
rm -rf ~/.synctx
```

The remote repository on GitHub can be deleted separately via `gh repo delete <username>/.synctx --yes` or from your GitHub settings.
