---
name: clean-sessions
description: Removes synced session data from the local staging directory with double confirmation. All cleaned sessions are tombstoned to prevent re-sync.
---

To clean the local staging directory:

```bash
node ./scripts/sync-engine.js clean
```

This will prompt the user for **double confirmation** because it deletes synced data from:
- `~/.synctx/github-copilot/`
- `~/.synctx/claude/`

The user must type "yes" twice to proceed.

**Important:**
- The user's original CLI session directories (~/.copilot/, ~/.claude/) are NEVER modified.
- All cleaned sessions are **tombstoned** — they will NOT be re-synced from any machine.
- Any tags pointing to cleaned sessions are automatically released.
- The cleanup is pushed to the remote sync repository.
