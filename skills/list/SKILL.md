---
name: list-sessions
description: Lists all synced AI CLI sessions. Pulls latest from remote first, then displays.
---

To list sessions, run:

```bash
node ./scripts/sync-engine.js list
```

This automatically pulls the latest data from remote before listing, so results include sessions from all machines.

To filter by CLI:

```bash
node ./scripts/sync-engine.js list --cli copilot
node ./scripts/sync-engine.js list --cli claude
```

To see all tagged sessions:

```bash
node ./scripts/sync-engine.js tags
```

Present the output to the user. Each session shows:
- Session ID (UUID or project name)
- Tags (if any, shown with 📌)
- Number of files
- Total size
- Last modified date

If the user asks to see only Copilot or Claude sessions, use the `--cli` flag accordingly.
