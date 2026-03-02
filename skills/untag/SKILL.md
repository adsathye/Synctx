---
name: untag-session
description: Removes a tag from a session. The session itself is not deleted.
---

To remove a tag:

1. **First list existing tags** so the user can identify which one to remove:
   ```bash
   node ./scripts/sync-engine.js tags
   ```

2. **Ask the user** which tag they want to remove.

3. **Run the untag command:**
   ```bash
   node ./scripts/sync-engine.js untag <tag-name>
   ```

   Example:
   ```bash
   node ./scripts/sync-engine.js untag auth-refactor
   ```

4. The tag removal is committed and pushed to the remote sync repository.

**Important:** Removing a tag does NOT delete the session — it only removes the friendly alias. The session remains accessible by its UUID.
