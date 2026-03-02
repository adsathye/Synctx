---
name: delete
description: Delete a specific session from the sync repo (fast path)
---

First ask the user which session to delete. If they don't know, run `list` first.

Then run:

```bash
node ./scripts/sync-engine.js delete <session-id>
```

Replace `<session-id>` with the ID the user provided. The command will ask for double confirmation. Do NOT bypass confirmation.

The deleted session is tombstoned — it will not be re-synced from other machines. Any tags pointing to the session are automatically released.
