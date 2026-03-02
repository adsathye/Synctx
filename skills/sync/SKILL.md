---
name: sync-sessions
description: Full bidirectional sync — pulls from remote, stages local sessions, scans for secrets, and pushes.
---

To perform a full sync (pull + push):

```bash
node ./scripts/sync-engine.js sync
```

This command:
1. Pulls the latest data from the remote sync repo (gets sessions from other machines)
2. Copies local session files from `~/.copilot/session-state/` and `~/.claude/projects/` into the sync directory
3. Scans all staged files with Gitleaks for secrets
4. If secrets are detected: **auto-redacts and proceeds**
5. Commits and pushes to the private sync repository

For background-only push (no pull, non-blocking):

```bash
node ./scripts/sync-engine.js push
```

To check sync status after running:
```bash
tail -5 ~/.synctx/security-audit/general.log
```
