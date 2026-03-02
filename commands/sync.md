---
name: sync
description: Full bidirectional sync — pulls from remote then pushes local sessions
---

Run this command to perform a full sync:

```bash
node ./scripts/sync-engine.js sync
```

This pulls the latest sessions from the remote repository, stages local session files, scans for secrets with Gitleaks, and pushes everything to the remote. Use this to ensure your local and remote are fully in sync.

For background-only push (non-interactive), use `push` instead.
