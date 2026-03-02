---
name: restore
description: Pull synced sessions from remote and restore for /resume
---

To restore a specific session by tag or ID:

```bash
node ./scripts/sync-engine.js restore <tag-or-session-id>
```

To pull all synced data without restoring a specific session:

```bash
node ./scripts/sync-engine.js restore
```

When a tag or session ID is provided, the session is copied back to the CLI's session directory so the user can run `/resume <session-id>` to continue where they left off.
