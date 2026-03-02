---
name: prune
description: Remove old sessions beyond retention period (fast path)
---

Run this command interactively — it requires the user to confirm:

```bash
node ./scripts/sync-engine.js prune --days 90
```

If the user specified a different retention period, adjust the `--days` value. The command will list what will be pruned and ask for double confirmation.

All pruned sessions are tombstoned — they will not be re-synced from other machines. Any tags pointing to pruned sessions are automatically released.
