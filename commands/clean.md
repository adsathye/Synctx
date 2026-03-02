---
name: clean
description: Clean the local staging directory (fast path)
---

Run this command interactively — it requires the user to confirm twice:

```bash
node ./scripts/sync-engine.js clean
```

The command will ask for double confirmation before deleting. Do NOT bypass the confirmation prompts.

All cleaned sessions are tombstoned — they will not be re-synced from any machine. Any tags are automatically released. Original CLI session directories are never modified.
