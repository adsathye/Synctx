---
name: delete-session
description: Deletes a specific session from the sync repository. Requires double confirmation before deletion.
---

To delete a session:

1. **First list available sessions** so the user can identify which one to delete:
   ```bash
   node ./scripts/sync-engine.js list
   ```
   Or check tagged sessions:
   ```bash
   node ./scripts/sync-engine.js tags
   ```

2. **Ask the user** which session they want to delete. They can provide the full UUID, a partial ID, a **tag name**, or **"current"** for the most recent active session.

3. **Run the delete command** — it will prompt for double confirmation automatically:
   ```bash
   node ./scripts/sync-engine.js delete <session-id-or-tag>
   ```

   To target a specific CLI:
   ```bash
   node ./scripts/sync-engine.js delete <session-id-or-tag> --cli copilot
   node ./scripts/sync-engine.js delete <session-id-or-tag> --cli claude
   ```

4. The user must type "yes" twice to confirm. Do NOT bypass this.

5. The deletion is committed and pushed to the remote sync repository.

6. The deleted session is **tombstoned** — it will not be re-synced from other machines. Any tags pointing to the session are automatically released.

**Important:** Always show the user what will be deleted (CLI, session name, size, tags) before proceeding.
