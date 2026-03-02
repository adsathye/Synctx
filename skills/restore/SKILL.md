---
name: restore-session
description: Restores a previous AI CLI session — either hot-loads into current context or prepares for /resume.
---

To restore a session, follow these steps strictly:

1. **Pull the latest data:**
   ```bash
   node ./scripts/sync-engine.js restore
   ```

2. **List Available Sessions:**
   ```bash
   node ./scripts/sync-engine.js list
   ```
   To see tagged sessions:
   ```bash
   node ./scripts/sync-engine.js tags
   ```

3. **Prompt the User:** Ask which session they want to restore. They can provide a session UUID, partial ID, a **tag name** (e.g., "auth-refactor"), or **"current"** to target the most recent active session.

4. **Ask the user how they want to restore:**

   > **Option A: Hot-load into this session** — I'll read the session history into our current conversation so you can continue seamlessly. Your current session ID stays the same.
   >
   > **Option B: Prepare for /resume** — I'll restore the session files so you can switch to it with `/resume <id>`. You'll get the original session with its full history.

5. **If Option A (Hot-Load):**

   **Explain to the user:**
   > ℹ️ Hot-load reads the old session's context into this conversation. Your current session ID stays the same — this is context injection, not a session switch. The original session remains untouched.

   Resolve tags if needed. Tags are stored in `~/.synctx/.tags.json`.

   **Auto-tag the current session:** If the restored session had a tag (e.g., "auth-refactor"), create a continuation tag for the current session so the user can find it later:
   ```bash
   node ./scripts/sync-engine.js tag <current-session-id> <original-tag>-continued
   ```
   For example, if restoring "auth-refactor", tag the current session as "auth-refactor-continued".
   Tell the user: `📌 Tagged this session as "<tag>-continued" for easy reference.`

   Read the session files from the **staging directory**:

   For Copilot sessions:
   ```bash
   cat ~/.synctx/github-copilot/session-state/<session-id>/events.jsonl
   ```

   For Claude sessions:
   ```bash
   find ~/.synctx/claude/projects/<project-name> -type f | head -20
   cat ~/.synctx/claude/projects/<project-name>/<session-file>
   ```

   Parse the conversation history and adopt it into your current context. Summarize the key points.
   Print: **"✅ Session hot-loaded into active memory! Here is where we left off: [brief summary]."**

6. **If Option B (Prepare for /resume):**

   Run restore with the tag or session ID to copy it back to the CLI session directory:
   ```bash
   node ./scripts/sync-engine.js restore <tag-or-session-id>
   ```

   Tell the user:
   > ✅ Session restored. To switch to it, run: `/resume <session-id>`

**IMPORTANT:** Never delete or modify the user's original session directories. Restore only copies FROM staging TO the CLI directory.
