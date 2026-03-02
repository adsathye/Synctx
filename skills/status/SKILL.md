---
name: session-status
description: Shows the current status of Synctx — sync directory, audit log, prerequisites, and CLI paths.
---

To check the status and configuration:

```bash
node ./scripts/sync-engine.js status
```

This shows:
- Platform and home directory
- Staging directory location
- Which CLI session paths exist on this machine
- Whether prerequisites are installed (Node.js, Git, GitHub CLI, Gitleaks)

To see recent sync activity:
```bash
tail -20 ~/.synctx/security-audit/general.log
tail -20 ~/.synctx/security-audit/copilot/copilot.log
tail -20 ~/.synctx/security-audit/claude/claude.log
tail -20 ~/.synctx/security-audit/redactions.log
```
