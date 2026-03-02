---
name: list-tags
description: Lists all session tags with their session IDs and CLI type.
---

To list all tags, run:

```bash
node ./scripts/sync-engine.js tags
```

This pulls the latest tag data from remote before listing, so results include tags created on all machines.

Present the output to the user. Each tag shows:
- Tag name (friendly alias)
- Session ID it points to
- CLI type (Copilot or Claude)

If no tags exist, suggest the user create one:
```bash
node ./scripts/sync-engine.js tag <session-id> <tag-name>
```

Tags can be used with `restore`, `delete`, and other commands in place of session IDs.
