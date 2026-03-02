---
name: push
description: Push local sessions to remote in the background
---

Run this command to push sessions to the remote sync repo:

```bash
node ./scripts/sync-engine.js push
```

This runs as a background daemon — your terminal returns immediately. For a full bidirectional sync (pull + push), use `sync` instead.
