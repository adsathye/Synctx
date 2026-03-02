---
name: tag-session
description: Assigns a friendly tag to a session for easy recall and cross-device restore.
---

To tag a session:

1. **First list available sessions** so the user can identify which one to tag:
   ```bash
   node ./scripts/sync-engine.js list
   ```

2. **Ask the user** which session they want to tag and what tag name to use. They can provide:
   - A full UUID: `e0e9f4b8-495b-4db7-a997-e03abb610a62`
   - A partial ID: `e0e9f4b8`
   - The keyword **"current"** for the most recently active Copilot session

3. **Run the tag command:**
   ```bash
   node ./scripts/sync-engine.js tag <session-id> <tag-name>
   ```

   Examples:
   ```bash
   node ./scripts/sync-engine.js tag e0e9f4b8 auth-refactor
   node ./scripts/sync-engine.js tag current my-feature
   ```

4. Tag names must be:
   - 2–50 characters
   - Lowercase alphanumeric with hyphens and underscores
   - Not look like a UUID

5. If the tag already exists on another machine for a different session, it will be auto-suffixed with the hostname to prevent conflicts.

6. The tag is committed and pushed to the remote sync repository so it's available on all machines.

Present the result to the user. Tags can then be used with `restore`, `delete`, and other commands.
